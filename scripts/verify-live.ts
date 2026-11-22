#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createPublicClient, parseAbi } from "viem";

import { rpcTransport, BASE_SEPOLIA_FALLBACKS, REACTIVE_FALLBACKS } from "./lib/rpc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(REPO_ROOT, "app", ".env.local"), quiet: true });
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const BASE_SEPOLIA_CHAIN_ID = 84532;
const REACTIVE_LASNA_CHAIN_ID = 5318007;

const RSC_ABI = parseAbi([
  "function CHAIN_ID() view returns (uint256)",
  "function owner() view returns (address)",
  "function callbackGasLimit() view returns (uint64)",
  "function sapuForwarder() view returns (address)",
  "function subscriptionCount() view returns (uint256)",
]);

const FORWARDER_ABI = parseAbi([
  "function _CALLBACK_SENDER() view returns (address)",
  "function owner() view returns (address)",
  "function sweepCount() view returns (uint256)",
]);

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

function requireAddr(primary: string, fallback: string): `0x${string}` {
  const val = process.env[primary] || process.env[fallback];
  if (!val || !/^0x[0-9a-fA-F]{40}$/.test(val)) {
    throw new Error(`Missing or invalid ${primary} (or ${fallback}) in app/.env.local`);
  }
  return val as `0x${string}`;
}

async function assertHasCode(
  label: string,
  address: `0x${string}`,
  client: ReturnType<typeof createPublicClient>,
): Promise<void> {
  const code = await client.getCode({ address });
  if (!code || code === "0x" || code === "0x0") {
    throw new Error(`${label} (${address}) has no bytecode (eth_getCode == 0x)`);
  }
}

async function main(): Promise<void> {
  const baseRpc = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const reactiveRpc = process.env.NEXT_PUBLIC_REACTIVE_RPC_URL || process.env.REACTIVE_RPC_URL || "https://lasna-rpc.rnk.dev/";

  const rscAddress = requireAddr("NEXT_PUBLIC_SAPU_RSC_ADDRESS", "SAPU_RSC_ADDRESS");
  const forwarderAddress = requireAddr("NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS", "SAPU_FORWARDER_ADDRESS");
  const tokenAddress = requireAddr("NEXT_PUBLIC_SAPU_TOKEN_ADDRESS", "SAPU_TOKEN_ADDRESS");

  const baseClient = createPublicClient({ transport: rpcTransport(baseRpc, BASE_SEPOLIA_FALLBACKS) });
  const reactiveClient = createPublicClient({ transport: rpcTransport(reactiveRpc, REACTIVE_FALLBACKS) });

  const [baseChainId, reactiveChainId] = await Promise.all([
    baseClient.getChainId(),
    reactiveClient.getChainId(),
  ]);
  if (baseChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Base RPC chainId mismatch: got ${baseChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  if (reactiveChainId !== REACTIVE_LASNA_CHAIN_ID) {
    throw new Error(`Reactive RPC chainId mismatch: got ${reactiveChainId}, expected ${REACTIVE_LASNA_CHAIN_ID}`);
  }

  await Promise.all([
    assertHasCode("SapuRSC", rscAddress, reactiveClient),
    assertHasCode("SapuForwarder", forwarderAddress, baseClient),
    assertHasCode("SweepableERC20", tokenAddress, baseClient),
  ]);

  const [rscChainId, rscOwner, gasLimit, rscForwarder, subCount] = await Promise.all([
    reactiveClient.readContract({ address: rscAddress, abi: RSC_ABI, functionName: "CHAIN_ID" }),
    reactiveClient.readContract({ address: rscAddress, abi: RSC_ABI, functionName: "owner" }),
    reactiveClient.readContract({ address: rscAddress, abi: RSC_ABI, functionName: "callbackGasLimit" }),
    reactiveClient.readContract({ address: rscAddress, abi: RSC_ABI, functionName: "sapuForwarder" }),
    reactiveClient.readContract({ address: rscAddress, abi: RSC_ABI, functionName: "subscriptionCount" }),
  ]);

  const [callbackSender, forwarderOwner, sweepCount] = await Promise.all([
    baseClient.readContract({ address: forwarderAddress, abi: FORWARDER_ABI, functionName: "_CALLBACK_SENDER" }),
    baseClient.readContract({ address: forwarderAddress, abi: FORWARDER_ABI, functionName: "owner" }),
    baseClient.readContract({ address: forwarderAddress, abi: FORWARDER_ABI, functionName: "sweepCount" }),
  ]);

  const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
    baseClient.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "name" }),
    baseClient.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "symbol" }),
    baseClient.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: "decimals" }),
  ]);

  if (rscChainId !== BigInt(BASE_SEPOLIA_CHAIN_ID)) {
    throw new Error(`SapuRSC.CHAIN_ID mismatch: got ${rscChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  if (callbackSender.toLowerCase() !== rscAddress.toLowerCase()) {
    throw new Error(`SapuForwarder._CALLBACK_SENDER (${callbackSender}) != SapuRSC (${rscAddress})`);
  }

  console.log("SAPU live deployment verified:");
  console.log(`  SapuRSC        ${rscAddress} (owner=${rscOwner}, gasLimit=${gasLimit}, forwarder=${rscForwarder}, subs=${subCount})`);
  console.log(`  SapuForwarder  ${forwarderAddress} (owner=${forwarderOwner}, callbackSender=${callbackSender}, sweepCount=${sweepCount})`);
  console.log(`  Token          ${tokenAddress} (${tokenName} / ${tokenSymbol}, decimals=${tokenDecimals})`);
}

main().catch((error) => {
  console.error("verify-live FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
