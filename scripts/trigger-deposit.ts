#!/usr/bin/env node
/**
 * scripts/trigger-deposit.ts
 *
 * Sends ERC-20 tokens to an empty burner on Base Sepolia — the Tx1 leg.
 *
 * This is deliberately the *only* thing the operator does. It does not fund the burner
 * with gas, does not approve anything from the burner, and does not touch the reactive
 * contract. Everything after this point is automatic.
 *
 * Usage:
 *   npx tsx scripts/trigger-deposit.ts
 *   npx tsx scripts/trigger-deposit.ts --amount 2.5
 *   npx tsx scripts/trigger-deposit.ts --burner 0x... --token 0x...
 *
 * Env:
 *   BASE_SEPOLIA_RPC_URL    required
 *   DEPLOYER_PRIVATE_KEY    required (sender)
 *   SAPU_TOKEN_ADDRESS      required unless --token
 *   SAPU_BURNER_ADDRESS     required unless --burner
 */

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadEnv } from "dotenv";

loadEnv();

const BASE_SEPOLIA_CHAIN_ID = 84532;

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

interface Args {
  amount: string;
  burner: `0x${string}`;
  token: `0x${string}`;
  rpcUrl: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const rpcUrl = get("--rpc") ?? process.env.BASE_SEPOLIA_RPC_URL;
  const token = (get("--token") ?? process.env.SAPU_TOKEN_ADDRESS) as `0x${string}` | undefined;
  const burner = (get("--burner") ?? process.env.SAPU_BURNER_ADDRESS) as `0x${string}` | undefined;
  const amount = get("--amount") ?? process.env.SAPU_DEPOSIT_AMOUNT ?? "1";

  const missing: string[] = [];
  if (!rpcUrl) missing.push("BASE_SEPOLIA_RPC_URL (or --rpc)");
  if (!token) missing.push("SAPU_TOKEN_ADDRESS (or --token)");
  if (!burner) missing.push("SAPU_BURNER_ADDRESS (or --burner)");
  if (missing.length > 0) {
    console.error("Missing required configuration:");
    for (const item of missing) console.error(`  - ${item}`);
    console.error("\nSee .env.example at the repository root.");
    process.exit(1);
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(token!)) {
    console.error(`Invalid token address: ${token}`);
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(burner!)) {
    console.error(`Invalid burner address: ${burner}`);
    process.exit(1);
  }

  return { amount, burner: burner!, token: token!, rpcUrl: rpcUrl! };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("DEPLOYER_PRIVATE_KEY is required — this is the wallet *sending* the deposit.");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = http(args.rpcUrl, { timeout: 30_000, retryCount: 2 });
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    console.error(`Expected Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) but RPC reports ${chainId}.`);
    process.exit(1);
  }

  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: args.token, abi: ERC20, functionName: "symbol" }) as Promise<string>,
    publicClient.readContract({ address: args.token, abi: ERC20, functionName: "decimals" }) as Promise<number>,
  ]);

  const amount = parseUnits(args.amount, Number(decimals));

  // Preconditions. The burner balance is the important one: a non-zero balance means a
  // previous deposit is still sitting there, which would make the latency measurement
  // ambiguous and could indicate the loop is not running.
  const [senderBalance, burnerBalance, burnerGas] = await Promise.all([
    publicClient.readContract({
      address: args.token,
      abi: ERC20,
      functionName: "balanceOf",
      args: [account.address],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: args.token,
      abi: ERC20,
      functionName: "balanceOf",
      args: [args.burner],
    }) as Promise<bigint>,
    publicClient.getBalance({ address: args.burner }),
  ]);

  console.log("== SAPU :: Tx1 deposit ==");
  console.log(`chain        Base Sepolia (${chainId})`);
  console.log(`token        ${symbol} ${args.token}`);
  console.log(`sender       ${account.address}`);
  console.log(`burner       ${args.burner}`);
  console.log(`amount       ${formatUnits(amount, Number(decimals))} ${symbol}`);
  console.log("");

  if (senderBalance < amount) {
    console.error(
      `Insufficient ${symbol}: have ${formatUnits(senderBalance, Number(decimals))}, need ${args.amount}.`,
    );
    process.exit(1);
  }

  if (burnerBalance > 0n) {
    console.warn(
      `warning: burner already holds ${formatUnits(burnerBalance, Number(decimals))} ${symbol}. ` +
        "A previous deposit may not have been swept.",
    );
  }

  // This is the whole point: the burner has no gas and does not need any.
  console.log(`burner ETH   ${formatUnits(burnerGas, 18)} (no gas required — this is the point)`);
  console.log("");

  const hash = await walletClient.writeContract({
    address: args.token,
    abi: ERC20,
    functionName: "transfer",
    args: [args.burner, amount],
    chain: null,
  });

  console.log(`tx1 sent     ${hash}`);
  console.log(`explorer     https://sepolia.basescan.org/tx/${hash}`);
  console.log("");
  console.log("waiting for inclusion…");

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

  console.log(`tx1 mined    block ${receipt.blockNumber} (status ${receipt.status})`);
  console.log("");
  console.log("Tx1 complete. The reactive contract should now fire without any further action.");
  console.log("Run `npx tsx scripts/verify-sweep.ts` to confirm the loop closed.");

  if (receipt.status !== "success") {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("trigger-deposit failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
