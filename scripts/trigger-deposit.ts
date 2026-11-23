#!/usr/bin/env node

import { createWalletClient, createPublicClient, parseUnits, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config as loadEnv } from "dotenv";

import { rpcTransport, signerTransport, sendWithReconcile, BASE_SEPOLIA_FALLBACKS } from "./lib/rpc";
import { explorerFor } from "./lib/explorers";

loadEnv({ quiet: true });

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
  const publicClient = createPublicClient({ transport: rpcTransport(args.rpcUrl, BASE_SEPOLIA_FALLBACKS) });
  const signerClient = createPublicClient({ transport: signerTransport(args.rpcUrl) });
  const walletClient = createWalletClient({ account, transport: signerTransport(args.rpcUrl) });

  const chainId = await publicClient.getChainId();
  const expectedOrigin = process.env.SAPU_ORIGIN_CHAIN_ID ? Number(process.env.SAPU_ORIGIN_CHAIN_ID) : null;
  if (expectedOrigin !== null && chainId !== expectedOrigin) {
    console.error(
      `RPC reports chain ${chainId} but SAPU_ORIGIN_CHAIN_ID is ${expectedOrigin}. ` +
        "The deposit would land on a chain the watcher is not subscribed to.",
    );
    process.exit(1);
  }

  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: args.token, abi: ERC20, functionName: "symbol" }) as Promise<string>,
    publicClient.readContract({ address: args.token, abi: ERC20, functionName: "decimals" }) as Promise<number>,
  ]);

  const amount = parseUnits(args.amount, Number(decimals));

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
  console.log(`chain        ${chainId}`);
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

  console.log(`burner ETH   ${formatUnits(burnerGas, 18)} (no gas required — this is the point)`);
  console.log("");

  const hash = await sendWithReconcile(
    "tx1 transfer",
    (nonce) =>
      walletClient.writeContract({
        address: args.token,
        abi: ERC20,
        functionName: "transfer",
        args: [args.burner, amount],
        chain: null,
        nonce,
      }),
    { client: signerClient, address: account.address },
  );

  console.log(`tx1 sent     ${hash}`);
  // The link is printed only when an explorer is known for this chain, so the script
  // cannot point at basescan for a deposit that landed somewhere else.
  const originExplorer = explorerFor(chainId, process.env.SAPU_ORIGIN_EXPLORER_URL);
  if (originExplorer !== null) {
    console.log(`explorer     ${originExplorer}/tx/${hash}`);
  }
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
