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
 *
 * ## Why `"token"` without an override is an error
 *
 * `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` is the deployment's *default* token, not the set of tokens
 * SAPU handles. A call that needs an ERC-20 address must name it (`override`), because there is
 * no defensible default: silently falling back to the configured token is how a USDC route was
 * once armed against SAPU's allowance. When the default is also unset, this throws — which is
 * the honest answer to "which token?" with no answer available.
 *
 * Use `chainIdFor` when only the chain is needed. Requiring an address to learn a chain id made
 * every token-agnostic write path fail on a deployment that had no default token configured.
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

/**
 * The chain a contract key lives on, without resolving its address.
 *
 * `ensureChain` and the fee overrides only need the chain. Deriving it through `contractTarget`
 * forced an address lookup that throws when the default token is unset, so a burner-signed
 * `approve` for an arbitrary token failed before it could be sent on a deployment that had no
 * default token configured.
 */
export function chainIdFor(key: ContractKey): number {
  const config = readDeploymentConfig();
  if (config.configurationError !== null) {
    throw new ConfigurationError(config.configurationError);
  }
  return key === "rsc" ? config.reactive.id : config.origin.id;
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
  /** Why the check did not pass. Absent only when `hasCode` is `true`. */
  readonly error?: string;
  /**
   * Whether SAPU cannot work without this address.
   *
   * `SapuRSC` and `SapuForwarder` are required: every route lives in one of them. The token is
   * **not**. SAPU is token-agnostic — the forwarder keys its rules by `(token, burner)` and the
   * RSC subscribes with the token as the log filter — and the registry and ledger discover their
   * tokens from `RouteRegistered` events. `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` only names the
   * deployment's default, the one the Arm form pre-fills.
   *
   * Treating it as required meant an unset (or mis-set) default token made `verified` false, and
   * every view went dark: a multi-token deployment that arms USDC and WETH was unusable because
   * the demo token was not configured. That is a configuration *warning*, not a broken contract.
   */
  readonly required: boolean;
}

export interface DeploymentVerification {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly checks: readonly CodeCheck[];
  /**
   * Problems that do not stop the app but that the operator should see.
   *
   * Currently: a configured default token whose address has no code. That is almost always a
   * typo in `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS`, and silently ignoring it would leave the Arm form
   * pre-filled with an address that cannot be armed.
   */
  readonly warnings: readonly string[];
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
  const targets: Array<{
    name: string;
    address: Address | null;
    chainId: number;
    client: PublicClient | null;
    required: boolean;
  }> = [
    {
      name: "SapuRSC",
      address: config.rscAddress,
      chainId: config.reactive.id,
      client: clientFor(config.reactive.id),
      required: true,
    },
    {
      name: "SapuForwarder",
      address: config.forwarderAddress,
      chainId: config.origin.id,
      client: clientFor(config.origin.id),
      required: true,
    },
    {
      // Optional: SAPU is token-agnostic and the registry discovers its tokens from events.
      // This address is only the Arm form's default, so a wrong or missing value must not make
      // the whole deployment look broken.
      name: "SweepableERC20",
      address: config.tokenAddress,
      chainId: config.origin.id,
      client: clientFor(config.origin.id),
      required: false,
    },
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
          required: target.required,
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
          required: target.required,
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
          required: target.required,
        };
      } catch (error) {
        return {
          name: target.name,
          chainId: target.chainId,
          address: target.address,
          hasCode: null,
          error: reasonOf(error),
          required: target.required,
        };
      }
    }),
  );

  return assessChecks(checks);
}

/**
 * Turns code checks into a verdict. Pure, so the rule that decides whether the app is usable is
 * testable without a chain.
 *
 * The one thing this must never do is let an optional address decide that a working deployment is
 * broken. SAPU's contracts are token-agnostic, so a bad default token is a note, not a verdict.
 */
export function assessChecks(checks: readonly CodeCheck[]): DeploymentVerification {
  const required = checks.filter((check) => check.required);

  // "Configured" means every required address was supplied at all — a different question from
  // whether those addresses hold code, which is what `verified` answers.
  const configured = required.every((check) => check.address !== null);
  const verified = configured && required.every((check) => check.hasCode === true);

  // An optional address that was set but did not answer is almost always a typo in the default
  // the Arm form pre-fills. Reported, never fatal.
  const warnings = checks
    .filter((check) => !check.required && check.address !== null && check.hasCode !== true)
    .map(
      (check) =>
        `Default token ${check.address} is not usable (${check.error ?? "code check did not answer"}). ` +
        `SAPU can still arm and sweep any ERC-20; clear or fix NEXT_PUBLIC_SAPU_TOKEN_ADDRESS so the Arm form stops pre-filling it.`,
    );

  return { configured, verified, checks, warnings };
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
