#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createPublicClient, formatUnits, parseAbi, parseAbiItem } from "viem";

import { rpcTransport, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
loadEnv({ path: path.join(REPO_ROOT, "app", ".env.local"), quiet: true });

const TOKENS_SWEPT = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

async function main(): Promise<void> {
  const baseRpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  const reactiveRpc = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";

  const base = createPublicClient({ transport: rpcTransport(baseRpc, BASE_SEPOLIA_FALLBACKS) });
  const reactive = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });

  const proof = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, "docs", "proof", "latest.json"), "utf8"),
  ) as {
    transactions: Record<string, { hash: `0x${string}`; blockNumber: string; chainId: number }>;
    contracts: { rsc: `0x${string}`; forwarder: `0x${string}`; token: `0x${string}` };
  };

  const token = proof.contracts.token;
  const forwarder = proof.contracts.forwarder;
  const [symbol, decimals] = await Promise.all([
    base.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
    base.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
  ]);

  const results: string[] = [];
  let ok = true;

  for (const [label, tx] of Object.entries(proof.transactions)) {
    const client = tx.chainId === 84532 ? base : reactive;
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    const statusOk = receipt.status === "success";
    ok &&= statusOk;
    results.push(
      `${statusOk ? "PASS" : "FAIL"}  ${label.padEnd(8)} ${tx.hash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`,
    );
  }

  const sweeps = await base.getLogs({
    address: forwarder,
    event: TOKENS_SWEPT,
    fromBlock: BigInt(proof.transactions.sweep!.blockNumber),
    toBlock: BigInt(proof.transactions.sweep!.blockNumber),
  });
  const sweep = sweeps[0];
  const coldWallet = sweep?.args.coldWallet ?? null;
  const sweptAmount = sweep?.args.amount ?? 0n;

  if (!sweep) ok = false;
  results.push(
    sweep
      ? `PASS  TokensSwept burner=${sweep.args.burner} amount=${formatUnits(sweptAmount, Number(decimals))} ${symbol} coldWallet=${coldWallet}`
      : "FAIL  no TokensSwept log in the sweep block",
  );

  if (coldWallet) {
    const coldBalance = await base.readContract({
      address: token,
      abi: ERC20,
      functionName: "balanceOf",
      args: [coldWallet],
    });
    results.push(`INFO  cold wallet ${coldWallet} holds ${formatUnits(coldBalance, Number(decimals))} ${symbol}`);
  }

  console.log(results.join("\n"));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("proof verification failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
