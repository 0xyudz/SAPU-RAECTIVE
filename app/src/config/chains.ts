import type { Address } from "@/domain/burner-route";

export interface ChainConfig {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly nativeSymbol: string;
  readonly txPath: (hash: string) => string;
}

export const BASE_SEPOLIA: ChainConfig = {
  id: 84532,
  name: "Base Sepolia",
  shortName: "base-sepolia",
  get rpcUrl() {
    return process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  },
  explorerUrl: "https://sepolia.basescan.org",
  nativeSymbol: "ETH",
  txPath: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
};

export const REACTIVE_LASNA: ChainConfig = {
  id: 5318007,
  name: "Reactive Lasna",
  shortName: "reactive-lasna",
  get rpcUrl() {
    return process.env.NEXT_PUBLIC_REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";
  },
  explorerUrl: "https://lasna.reactscan.net",
  nativeSymbol: "lREACT",
  txPath: (hash) => `https://lasna.reactscan.net/tx/${hash}`,
};

export const SYSTEM_CONTRACT: Address = "0x8888888888888888888888888888888888888888";

export const BASE_SEPOLIA_CALLBACK_PROXY: Address = "0x476f44b11f5c942c58f4c8e3d0300e5710743585";

export interface DeploymentConfig {
  readonly rscAddress: Address | null;
  readonly forwarderAddress: Address | null;
  readonly tokenAddress: Address | null;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly rscDeployBlock: bigint | null;
  readonly forwarderDeployBlock: bigint | null;
  readonly callbackProxy: Address;
}

const DEFAULT_CALLBACK_PROXY: Address = BASE_SEPOLIA_CALLBACK_PROXY;

function readBlock(value: string | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

export function readDeploymentConfig(): DeploymentConfig {
  const rsc = process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS;
  const forwarder = process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS;
  const token = process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS;
  const callbackProxy = process.env.NEXT_PUBLIC_SAPU_CALLBACK_PROXY;

  return {
    rscAddress: isAddressLike(rsc) ? (rsc.toLowerCase() as Address) : null,
    forwarderAddress: isAddressLike(forwarder) ? (forwarder.toLowerCase() as Address) : null,
    tokenAddress: isAddressLike(token) ? (token.toLowerCase() as Address) : null,
    tokenSymbol: process.env.NEXT_PUBLIC_SAPU_TOKEN_SYMBOL ?? "SAPU",
    tokenDecimals: Number(process.env.NEXT_PUBLIC_SAPU_TOKEN_DECIMALS ?? "18"),
    rscDeployBlock: readBlock(process.env.NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK),
    forwarderDeployBlock: readBlock(process.env.NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK),
    callbackProxy: isAddressLike(callbackProxy) ? (callbackProxy.toLowerCase() as Address) : DEFAULT_CALLBACK_PROXY,
  };
}

function isAddressLike(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isFullyConfigured(config: DeploymentConfig): boolean {
  return config.rscAddress !== null && config.forwarderAddress !== null && config.tokenAddress !== null;
}
