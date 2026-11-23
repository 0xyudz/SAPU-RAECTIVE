import type { Abi, PublicClient } from "viem";
import { BASE_SEPOLIA, REACTIVE_LASNA, SYSTEM_CONTRACT, readDeploymentConfig } from "@/config/chains";
import { erc20Abi, payerAbi, sapuForwarderAbi, sapuRscAbi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";
import type { ContractKey } from "@/application/ports";
import { getBaseClient, getReactiveClient } from "./rpc-clients";
import { withRpcRetry } from "./rpc-retry";
import { reasonOf } from "./reason";

export { getBaseClient, getReactiveClient };

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

export function contractTarget(key: ContractKey): ContractTarget {
  const config = readDeploymentConfig();
  if (key === "rsc") {
    return {
      key,
      address: requireAddress("SAPU_RSC_ADDRESS", config.rscAddress),
      abi: sapuRscAbi,
      chainId: REACTIVE_LASNA.id,
      client: getReactiveClient(),
    };
  }
  if (key === "forwarder") {
    return {
      key,
      address: requireAddress("SAPU_FORWARDER_ADDRESS", config.forwarderAddress),
      abi: sapuForwarderAbi,
      chainId: BASE_SEPOLIA.id,
      client: getBaseClient(),
    };
  }
  return {
    key,
    address: requireAddress("SAPU_TOKEN_ADDRESS", config.tokenAddress),
    abi: erc20Abi,
    chainId: BASE_SEPOLIA.id,
    client: getBaseClient(),
  };
}

export function payerTarget(kind: "system" | "callback-proxy"): {
  address: Address;
  abi: typeof payerAbi;
  chainId: number;
  client: PublicClient;
} {
  if (kind === "system") {
    return {
      address: SYSTEM_CONTRACT,
      abi: payerAbi,
      chainId: REACTIVE_LASNA.id,
      client: getReactiveClient(),
    };
  }
  return {
    address: readDeploymentConfig().callbackProxy,
    abi: payerAbi,
    chainId: BASE_SEPOLIA.id,
    client: getBaseClient(),
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
  const key = `${config.rscAddress}|${config.forwarderAddress}|${config.tokenAddress}`;
  const now = Date.now();
  if (verifyCache !== null && verifyCache.key === key && now - verifyCache.at < VERIFY_TTL_MS) {
    return verifyCache.promise;
  }

  const promise = runVerification(config);
  verifyCache = { at: now, key, promise };
  return promise;
}

async function runVerification(config: ReturnType<typeof readDeploymentConfig>): Promise<DeploymentVerification> {
  const targets: Array<{ name: string; address: Address | null; chainId: number; client: PublicClient }> = [
    { name: "SapuRSC", address: config.rscAddress, chainId: REACTIVE_LASNA.id, client: getReactiveClient() },
    {
      name: "SapuForwarder",
      address: config.forwarderAddress,
      chainId: BASE_SEPOLIA.id,
      client: getBaseClient(),
    },
    { name: "SweepableERC20", address: config.tokenAddress, chainId: BASE_SEPOLIA.id, client: getBaseClient() },
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
      try {
        const code = await withRpcRetry(() => target.client.getCode({ address: target.address! }));
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

interface VerifyCacheEntry {
  readonly at: number;
  readonly key: string;
  readonly promise: Promise<DeploymentVerification>;
}

let verifyCache: VerifyCacheEntry | null = null;
const VERIFY_TTL_MS = 20_000;
