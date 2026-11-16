/**
 * Chain configuration.
 *
 * Every value here is a real, verifiable protocol constant. Nothing is invented:
 * the callback proxy and chain ids come from dev.reactive.network, and the token
 * address is supplied at deploy time because it is deployed, not hardcoded.
 */

import type { Address } from "@/domain/burner-route";

export interface ChainConfig {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly nativeSymbol: string;
  /** Blockscout/Reactscan base for tx links. */
  readonly txPath: (hash: string) => string;
}

export const BASE_SEPOLIA: ChainConfig = {
  id: 84532,
  name: "Base Sepolia",
  shortName: "base-sepolia",
  rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  explorerUrl: "https://sepolia.basescan.org",
  nativeSymbol: "ETH",
  txPath: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
};

export const REACTIVE_LASNA: ChainConfig = {
  id: 5318007,
  name: "Reactive Lasna",
  shortName: "reactive-lasna",
  rpcUrl: process.env.NEXT_PUBLIC_REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/",
  explorerUrl: "https://lasna.reactscan.net",
  nativeSymbol: "lREACT",
  txPath: (hash) => `https://lasna.reactscan.net/tx/${hash}`,
};

/** The system contract, identical on Reactive Mainnet and Lasna. */
export const SYSTEM_CONTRACT: Address = "0x8888888888888888888888888888888888888888";

/** Base Sepolia callback proxy. Source: dev.reactive.network/origins-and-destinations */
export const BASE_SEPOLIA_CALLBACK_PROXY: Address = "0x476f44b11f5c942c58f4c8e3d0300e5710743585";

/** keccak256("Transfer(address,address,uint256)") — origin event on Base Sepolia. */
export const TRANSFER_TOPIC_0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** keccak256("TokensSwept(address,address,address,uint256,address)") — Tx3 proof. */
export const TOKENS_SWEPT_TOPIC_0 =
  "0x1769901594938d4b192c89308e322eb4bbea492c40a9086b66fa2a4959696454" as const;

/** keccak256("CallbackRequest(uint256,address,address,uint8,bytes)") — Tx2 proof. */
export const CALLBACK_REQUEST_TOPIC_0 =
  "0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133" as const;

/** keccak256("PurgeTriggered(address,address,address,uint256,uint256)") — emitted by SapuRSC. */
export const PURGE_TRIGGERED_TOPIC_0 =
  "0x53d7f90da15ba4bfefb8a0218199a17d3ffe46ff0ac0e8ed7f5412c68fceee82" as const;

/** keccak256("RouteRegistered(address,address,address,uint64)") — emitted by SapuRSC. */
export const ROUTE_REGISTERED_TOPIC_0 =
  "0x7e571268b552d1d67a4c93efce5bf02e75e6d8aa029be4b6def415093ae5f1e1" as const;

/** keccak256("RouteArmed(address,address,address)") — emitted by SapuForwarder. */
export const ROUTE_ARMED_TOPIC_0 =
  "0x573579f5e2178b36a3bd351e6f8f026ba86fad0790363797f1317ab28e87a48a" as const;

export interface DeploymentConfig {
  /** SapuRSC on Reactive Lasna. */
  readonly rscAddress: Address | null;
  /** SapuForwarder on Base Sepolia. */
  readonly forwarderAddress: Address | null;
  /** SweepableERC20 on Base Sepolia. */
  readonly tokenAddress: Address | null;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
}

/**
 * Reads deployment addresses from the environment.
 *
 * Returns `null` rather than a placeholder when unset. The UI must be able to tell
 * the difference between "not deployed yet" and "deployed at 0x0000…", because the
 * former is a setup step and the latter is a bug.
 */
export function readDeploymentConfig(): DeploymentConfig {
  const rsc = process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS;
  const forwarder = process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS;
  const token = process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS;

  return {
    rscAddress: isAddressLike(rsc) ? (rsc.toLowerCase() as Address) : null,
    forwarderAddress: isAddressLike(forwarder) ? (forwarder.toLowerCase() as Address) : null,
    tokenAddress: isAddressLike(token) ? (token.toLowerCase() as Address) : null,
    tokenSymbol: process.env.NEXT_PUBLIC_SAPU_TOKEN_SYMBOL ?? "SAPU",
    tokenDecimals: Number(process.env.NEXT_PUBLIC_SAPU_TOKEN_DECIMALS ?? "18"),
  };
}

function isAddressLike(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** True when every contract address needed for the live loop is present. */
export function isFullyConfigured(config: DeploymentConfig): boolean {
  return config.rscAddress !== null && config.forwarderAddress !== null && config.tokenAddress !== null;
}
