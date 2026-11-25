import type { Address } from "@/domain/burner-route";

/**
 * Every chain Reactive Network can read events from (origin) or deliver a callback to
 * (destination), transcribed from the official table at
 * https://dev.reactive.network/origins-and-destinations.
 *
 * This table is the single place a chain fact may live. The callback proxy address is *per
 * chain* and a wrong one makes `onlyServiceProvider` reject every callback, so it cannot be
 * guessed or shared — a chain literal in a module is how a deployment ends up watching one
 * chain and delivering to another.
 *
 * Chain ids and callback proxies are copied from the official docs. Explorer URLs are the
 * ones the docs link to. The native symbol is only recorded where the docs or the chain's
 * own explorer state it — `null` means "not stated", and the UI prints "native" rather
 * than inventing a ticker. RPC endpoints are deliberately *not* invented: Reactive
 * publishes them only for its own chains, so everything else must come from the operator
 * (see `config/chain-rpc.ts`).
 */

export type ReactiveNetwork = "mainnet" | "testnet";

export interface ChainConfig {
  readonly id: number;
  readonly name: string;
  /** Slug used in the chain indicator and in log lines. */
  readonly shortName: string;
  readonly network: ReactiveNetwork;
  /**
   * Callback proxy on this chain. Callbacks are delivered by Reactive Signer through this
   * contract, so a destination validates `msg.sender == callbackProxy`.
   */
  readonly callbackProxy: Address;
  readonly explorerUrl: string;
  /** `null` when the official docs do not state a ticker. Never guess one. */
  readonly nativeSymbol: string | null;
  readonly nativeDecimals: number;
  readonly txPath: (hash: string) => string;
  /** True when Reactive lists this chain as an origin. */
  readonly origin: boolean;
  /** True when Reactive lists this chain as a destination. */
  readonly destination: boolean;
  /** True for the Reactive chains themselves, where reactive contracts execute. */
  readonly reactive: boolean;
}

/** Reactive's own system contract sits at the same address on mainnet and Lasna. */
export const SYSTEM_CONTRACT: Address = "0x8888888888888888888888888888888888888888";

/**
 * Canonical Multicall3 deployment, identical on every chain that has it. Batch reads are
 * advisory: a missing deployment degrades to individual calls, never to invented values.
 */
export const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";

function chain(
  config: Omit<ChainConfig, "txPath" | "nativeDecimals"> & { readonly nativeDecimals?: number },
): ChainConfig {
  const explorerUrl = config.explorerUrl.replace(/\/$/, "");
  return {
    ...config,
    nativeDecimals: config.nativeDecimals ?? 18,
    txPath: (hash) => `${explorerUrl}/tx/${hash}`,
  };
}

// -----------------------------------------------------------------------------
// Mainnet
// -----------------------------------------------------------------------------

export const ETHEREUM = chain({
  id: 1,
  name: "Ethereum",
  shortName: "ethereum",
  network: "mainnet",
  callbackProxy: "0xfce1f192f489c988392abc16e91e359d540d94fe",
  explorerUrl: "https://etherscan.io",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const BSC = chain({
  id: 56,
  name: "BSC",
  shortName: "bsc",
  network: "mainnet",
  callbackProxy: "0xfc41ee9d3a836b41399becce83b06b3e5650f3bb",
  explorerUrl: "https://bscscan.com",
  nativeSymbol: "BNB",
  origin: true,
  destination: true,
  reactive: false,
});

export const UNICHAIN = chain({
  id: 130,
  name: "Unichain",
  shortName: "unichain",
  network: "mainnet",
  callbackProxy: "0x754120ec7a6ef81e4c5c835aa603c63da64693e6",
  explorerUrl: "https://uniscan.xyz",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const HYPEREVM = chain({
  id: 999,
  name: "HyperEVM",
  shortName: "hyperevm",
  network: "mainnet",
  callbackProxy: "0x754120ec7a6ef81e4c5c835aa603c63da64693e6",
  explorerUrl: "https://hyperevmscan.io",
  nativeSymbol: "HYPE",
  origin: true,
  destination: true,
  reactive: false,
});

export const REACTIVE_MAINNET = chain({
  id: 1597,
  name: "Reactive",
  shortName: "reactive",
  network: "mainnet",
  // The Reactive chain's "callback proxy" entry in the docs is the system contract
  // itself: reactive contracts are called by it directly, with no separate proxy hop.
  callbackProxy: SYSTEM_CONTRACT,
  explorerUrl: "https://reactscan.net",
  nativeSymbol: "REACT",
  origin: true,
  destination: true,
  reactive: true,
});

export const ROBINHOOD = chain({
  id: 4663,
  name: "Robinhood",
  shortName: "robinhood",
  network: "mainnet",
  callbackProxy: "0x476f44b11f5c942c58f4c8e3d0300e5710743585",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  // The official table links the explorer but does not name a gas token, so this stays
  // unset. The UI prints "native" instead of asserting a ticker.
  nativeSymbol: null,
  origin: true,
  destination: true,
  reactive: false,
});

export const BASE = chain({
  id: 8453,
  name: "Base",
  shortName: "base",
  network: "mainnet",
  callbackProxy: "0xcc780dde33f56f55de778d42c930959374a4a068",
  explorerUrl: "https://basescan.org",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const ARBITRUM = chain({
  id: 42161,
  name: "Arbitrum",
  shortName: "arbitrum",
  network: "mainnet",
  callbackProxy: "0xaee8d2debab5be353bfec167c58a549923892e11",
  explorerUrl: "https://arbiscan.io",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const AVALANCHE = chain({
  id: 43114,
  name: "Avalanche",
  shortName: "avalanche",
  network: "mainnet",
  callbackProxy: "0x8bdfc7e564b90b31c49cf1079d4c44400f4e14b4",
  explorerUrl: "https://avascan.info",
  nativeSymbol: "AVAX",
  origin: true,
  destination: true,
  reactive: false,
});

// -----------------------------------------------------------------------------
// Testnet
// -----------------------------------------------------------------------------

export const UNICHAIN_SEPOLIA = chain({
  id: 1301,
  name: "Unichain Sepolia",
  shortName: "unichain-sepolia",
  network: "testnet",
  callbackProxy: "0x775c9b990ade401060b78d0e98684eef8d2466c1",
  explorerUrl: "https://sepolia.uniscan.xyz",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const REACTIVE_LASNA = chain({
  id: 5318007,
  name: "Reactive Lasna",
  shortName: "reactive-lasna",
  network: "testnet",
  callbackProxy: SYSTEM_CONTRACT,
  explorerUrl: "https://lasna.reactscan.net",
  nativeSymbol: "lREACT",
  origin: true,
  destination: true,
  reactive: true,
});

export const BASE_SEPOLIA = chain({
  id: 84532,
  name: "Base Sepolia",
  shortName: "base-sepolia",
  network: "testnet",
  callbackProxy: "0x476f44b11f5c942c58f4c8e3d0300e5710743585",
  explorerUrl: "https://sepolia.basescan.org",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

export const ETHEREUM_SEPOLIA = chain({
  id: 11155111,
  name: "Ethereum Sepolia",
  shortName: "ethereum-sepolia",
  network: "testnet",
  callbackProxy: "0xaa14d9cd0f788ca23d11805986c1d8bd035d23b4",
  explorerUrl: "https://sepolia.etherscan.io",
  nativeSymbol: "ETH",
  origin: true,
  destination: true,
  reactive: false,
});

/** Every chain in the official table, mainnet and testnet. */
export const CHAINS: readonly ChainConfig[] = [
  ETHEREUM,
  BSC,
  UNICHAIN,
  HYPEREVM,
  REACTIVE_MAINNET,
  ROBINHOOD,
  BASE,
  ARBITRUM,
  AVALANCHE,
  UNICHAIN_SEPOLIA,
  REACTIVE_LASNA,
  BASE_SEPOLIA,
  ETHEREUM_SEPOLIA,
];

export function chainById(chainId: number): ChainConfig | null {
  return CHAINS.find((candidate) => candidate.id === chainId) ?? null;
}

/** Origin chains for a network, i.e. chains whose logs a reactive contract may watch. */
export function originChains(network: ReactiveNetwork): readonly ChainConfig[] {
  return CHAINS.filter((candidate) => candidate.network === network && candidate.origin);
}

/** The Reactive chain that executes contracts for a network. */
export function reactiveChain(network: ReactiveNetwork): ChainConfig {
  return network === "mainnet" ? REACTIVE_MAINNET : REACTIVE_LASNA;
}

/** Human label for a chain id, falling back to the raw id rather than guessing a name. */
export function chainLabel(chainId: number): string {
  return chainById(chainId)?.name ?? `chain ${chainId}`;
}

// -----------------------------------------------------------------------------
// Deployment configuration
// -----------------------------------------------------------------------------

export interface DeploymentConfig {
  readonly network: ReactiveNetwork;
  /**
   * Chain the swept token lives on: the event source, and the chain the forwarder runs on.
   * SAPU is symmetric — origin and destination are the same chain — because the callback
   * only needs to move tokens that were deposited on that chain.
   */
  readonly origin: ChainConfig;
  /** Reactive chain executing `SapuRSC`. */
  readonly reactive: ChainConfig;
  readonly rscAddress: Address | null;
  readonly forwarderAddress: Address | null;
  readonly tokenAddress: Address | null;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly rscDeployBlock: bigint | null;
  readonly forwarderDeployBlock: bigint | null;
  readonly callbackProxy: Address;
  /**
   * Set when the configured origin/reactive pair cannot be used. Reported to the UI as a
   * configuration failure; never silently coerced into a default pair, because reading the
   * wrong chain produces confident nonsense.
   */
  readonly configurationError: string | null;
}

function readBlock(value: string | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function isAddressLike(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function readNetwork(): ReactiveNetwork {
  return process.env.NEXT_PUBLIC_SAPU_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

function readChainId(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  return Number(value.trim());
}

/**
 * Resolves the deployment's chain pair.
 *
 * Mainnet and testnet must never be mixed: the docs are explicit that a mainnet origin
 * requires a mainnet destination. The callback proxy is per chain too, so a mixed pair
 * would deploy a forwarder that no real callback can ever satisfy.
 */
function resolveChains(): {
  network: ReactiveNetwork;
  origin: ChainConfig;
  reactive: ChainConfig;
  configurationError: string | null;
} {
  const network = readNetwork();
  const reactive = reactiveChain(network);
  const defaultOrigin = network === "mainnet" ? BASE : BASE_SEPOLIA;
  const originId = readChainId(process.env.NEXT_PUBLIC_SAPU_ORIGIN_CHAIN_ID, defaultOrigin.id);
  const origin = chainById(originId);

  if (origin === null) {
    return {
      network,
      origin: defaultOrigin,
      reactive,
      configurationError: `Origin chain ${originId} is not a Reactive-supported chain. Supported origin chains: ${originChains(
        network,
      )
        .map((candidate) => `${candidate.name} (${candidate.id})`)
        .join(", ")}.`,
    };
  }

  if (!origin.origin) {
    return {
      network,
      origin,
      reactive,
      configurationError: `${origin.name} is not listed as a Reactive origin chain.`,
    };
  }

  if (origin.network !== network) {
    return {
      network,
      origin,
      reactive,
      configurationError: `Origin ${origin.name} is a ${origin.network} chain but NEXT_PUBLIC_SAPU_NETWORK is "${network}". Mainnet and testnet must not be mixed.`,
    };
  }

  if (origin.reactive) {
    return {
      network,
      origin,
      reactive,
      configurationError: `${origin.name} is a Reactive chain; pick a token chain as the origin.`,
    };
  }

  return { network, origin, reactive, configurationError: null };
}

export function readDeploymentConfig(): DeploymentConfig {
  const { network, origin, reactive, configurationError } = resolveChains();
  const rsc = process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS;
  const forwarder = process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS;
  const token = process.env.NEXT_PUBLIC_SAPU_TOKEN_ADDRESS;
  const callbackProxy = process.env.NEXT_PUBLIC_SAPU_CALLBACK_PROXY;

  return {
    network,
    origin,
    reactive,
    rscAddress: isAddressLike(rsc) ? (rsc.toLowerCase() as Address) : null,
    forwarderAddress: isAddressLike(forwarder) ? (forwarder.toLowerCase() as Address) : null,
    tokenAddress: isAddressLike(token) ? (token.toLowerCase() as Address) : null,
    tokenSymbol: process.env.NEXT_PUBLIC_SAPU_TOKEN_SYMBOL ?? "SAPU",
    tokenDecimals: Number(process.env.NEXT_PUBLIC_SAPU_TOKEN_DECIMALS ?? "18"),
    rscDeployBlock: readBlock(process.env.NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK),
    forwarderDeployBlock: readBlock(process.env.NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK),
    // Default to the origin chain's own proxy. An override exists for the case where a
    // proxy was redeployed, but the chain table is the source of truth for every chain.
    callbackProxy: isAddressLike(callbackProxy)
      ? (callbackProxy.toLowerCase() as Address)
      : origin.callbackProxy,
    configurationError,
  };
}

export function isFullyConfigured(config: DeploymentConfig): boolean {
  // The token is deliberately not required: it is the Arm form's default, not the set of assets
  // SAPU handles. Requiring it made a multi-token deployment look unconfigured.
  return (
    config.configurationError === null &&
    config.rscAddress !== null &&
    config.forwarderAddress !== null
  );
}
