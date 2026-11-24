import type { Abi, PublicClient } from "viem";
import { SYSTEM_CONTRACT, readDeploymentConfig } from "@/config/chains";
import { erc20Abi, payerAbi, sapuForwarderAbi, sapuRscAbi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";
import type { ContractKey } from "@/application/ports";
import { getClient, getOriginClient, getReactiveClient } from "./rpc-clients";
import { withRpcRetry } from "./rpc-retry";
import { reasonOf } from "./reason";

export { getClient, getOriginClient, getReactiveClient };

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface ContractTarget {
  readonly key: ContractKey;
  readonly address: Address;
  readonly abi: Abi;
  readonly chainId: number;
  readonly client: PublicClient;
}

function requireAddress(name: string, value: Address | null): Address {
  if (value === null) {
    throw new ConfigurationError(
      `${name} is not configured. Set it in .env.local or run scripts/deploy-live.sh.`,
    );
  }
  return value;
}

/**
 * Where each SAPU contract lives.
 *
 * `rsc` runs on the Reactive chain; `forwarder` and `token` live on the token chain, which
 * is also the origin and the callback destination. Both ids come from the deployment
 * config, so pointing the app at another Reactive-supported chain is a configuration
 * change, not a code change.
 */
/**
 * Resolve a contract key to its address, ABI, chain and client.
 *
 * `override` replaces the address only. SAPU's contracts are token-agnostic — the forwarder
 * keys rules by `(token, burner)` and the RSC subscribes per pair — so a call may legitimately
 * target any ERC-20 on the origin chain while still using the token ABI and client. The chain
 * and ABI are deliberately not overridable: a caller must not be able to reach another
 * network or reinterpret one contract's calldata as another's.
 */
export function contractTarget(key: ContractKey, override?: Address): ContractTarget {
  const config = readDeploymentConfig();

  if (config.configurationError !== null) {
    throw new ConfigurationError(config.configurationError);
  }

  if (key === "rsc") {
    return {
      key,
      address: override ?? requireAddress("SAPU_RSC_ADDRESS", config.rscAddress),
      abi: sapuRscAbi,
      chainId: config.reactive.id,
      client: getReactiveClient(),
    };
  }
  if (key === "forwarder") {
    return {
      key,
      address: override ?? requireAddress("SAPU_FORWARDER_ADDRESS", config.forwarderAddress),
      abi: sapuForwarderAbi,
      chainId: config.origin.id,
      client: getOriginClient(),
    };
  }
  return {
    key,
    address: override ?? requireAddress("SAPU_TOKEN_ADDRESS", config.tokenAddress),
    abi: erc20Abi,
    chainId: config.origin.id,
    client: getOriginClient(),
  };
}

export function payerTarget(kind: "system" | "callback-proxy"): {
  address: Address;
  abi: typeof payerAbi;
  chainId: number;
  client: PublicClient;
} {
  const config = readDeploymentConfig();
  if (kind === "system") {
    return {
      address: SYSTEM_CONTRACT,
      abi: payerAbi,
      chainId: config.reactive.id,
      client: getReactiveClient(),
    };
  }
  return {
    address: config.callbackProxy,
    abi: payerAbi,
    chainId: config.origin.id,
    client: getOriginClient(),
  };
}

export interface CodeCheck {
  readonly name: string;
  readonly chainId: number;
  readonly address: Address | null;
  readonly hasCode: boolean | null;
  readonly error?: string;
}

export interface DeploymentVerification {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly checks: readonly CodeCheck[];
}

export async function verifyDeployment(): Promise<DeploymentVerification> {
  const config = readDeploymentConfig();
  const key = [
    config.origin.id,
    config.reactive.id,
    config.rscAddress,
    config.forwarderAddress,
    config.tokenAddress,
  ].join("|");
  const now = Date.now();
  if (verifyCache !== null && verifyCache.key === key && now - verifyCache.at < VERIFY_TTL_MS) {
    return verifyCache.promise;
  }

  const promise = runVerification(config);
  verifyCache = { at: now, key, promise };
  return promise;
}

async function runVerification(config: ReturnType<typeof readDeploymentConfig>): Promise<DeploymentVerification> {
  const targets: Array<{ name: string; address: Address | null; chainId: number; client: PublicClient | null }> = [
    { name: "SapuRSC", address: config.rscAddress, chainId: config.reactive.id, client: clientFor(config.reactive.id) },
    {
      name: "SapuForwarder",
      address: config.forwarderAddress,
      chainId: config.origin.id,
      client: clientFor(config.origin.id),
    },
    { name: "SweepableERC20", address: config.tokenAddress, chainId: config.origin.id, client: clientFor(config.origin.id) },
  ];

  const checks = await Promise.all(
    targets.map(async (target): Promise<CodeCheck> => {
      if (target.address === null) {
        return {
          name: target.name,
          chainId: target.chainId,
          address: null,
          hasCode: null,
          error: "address not configured",
        };
      }
      // An unconfigured RPC is a configuration failure, not a chain fact: report it as an
      // unknown code check so nothing claims "this address has no contract".
      if (target.client === null) {
        return {
          name: target.name,
          chainId: target.chainId,
          address: target.address,
          hasCode: null,
          error: `no RPC endpoint configured for chain ${target.chainId}`,
        };
      }
      try {
        const code = await withRpcRetry(() => target.client!.getCode({ address: target.address! }));
        const hasCode = typeof code === "string" && code !== "0x" && code !== "0x0";
        return {
          name: target.name,
          chainId: target.chainId,
          address: target.address,
          hasCode,
          error: hasCode ? undefined : "eth_getCode returned 0x — no contract at this address",
        };
      } catch (error) {
        return {
          name: target.name,
          chainId: target.chainId,
          address: target.address,
          hasCode: null,
          error: reasonOf(error),
        };
      }
    }),
  );

  const configured = checks.every((check) => check.address !== null);
  const verified = configured && checks.every((check) => check.hasCode === true);
  return { configured, verified, checks };
}

function clientFor(chainId: number): PublicClient | null {
  try {
    return getClient(chainId);
  } catch {
    return null;
  }
}

interface VerifyCacheEntry {
  readonly at: number;
  readonly key: string;
  readonly promise: Promise<DeploymentVerification>;
}

let verifyCache: VerifyCacheEntry | null = null;
const VERIFY_TTL_MS = 20_000;
