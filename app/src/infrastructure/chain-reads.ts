import type { Address } from "@/domain/burner-route";
import { contractTarget, payerTarget } from "./contracts";
import { lower } from "./address";
import { withRpcRetry } from "./rpc-retry";

export interface RouteRead {
  readonly coldWallet: Address;
  readonly active: boolean;
  readonly registeredBlock: bigint;
}

export async function readRoute(rsc: Address, token: Address, burner: Address): Promise<RouteRead> {
  const target = contractTarget("rsc");
  const route = (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "routeOf",
    args: [token, burner],
  })) as { coldWallet: Address; active: boolean; registeredBlock: bigint };
  return { coldWallet: lower(route.coldWallet), active: route.active, registeredBlock: route.registeredBlock };
}

export async function readForwarderSet(rsc: Address): Promise<Address> {
  const target = contractTarget("rsc");
  return lower(
    (await target.client.readContract({
      address: rsc,
      abi: target.abi,
      functionName: "sapuForwarder",
    })) as string,
  );
}

export async function readOwner(key: "rsc" | "forwarder"): Promise<Address | null> {
  const target = contractTarget(key);
  try {
    // Retried *inside* the catch, for the same reason as `readDebt`: the catch below converts a
    // transport failure into `null`, so no caller-side retry can ever see the error. A transient
    // 429 would otherwise be published as "owner unreadable", which the arm page shows as "could
    // not be read — not a verdict".
    const owner = (await withRpcRetry(() =>
      target.client.readContract({
        address: target.address,
        abi: target.abi,
        functionName: "owner",
      }),
    )) as string;
    return lower(owner);
  } catch {
    return null;
  }
}

export async function readCallbackGasLimit(rsc: Address): Promise<bigint> {
  const target = contractTarget("rsc");
  return (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "callbackGasLimit",
  })) as bigint;
}

/**
 * The on-chain dust floor, in token base units.
 *
 * A deposit below this is refused with `DustIgnored` instead of triggering a callback, so the
 * operator needs to see it next to the gas limit: the two numbers together decide whether a
 * given deposit is worth reacting to.
 */
export async function readMinDeposit(rsc: Address): Promise<bigint> {
  const target = contractTarget("rsc");
  return (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "minDeposit",
  })) as bigint;
}

export async function readSweepCount(forwarder: Address): Promise<bigint> {
  const target = contractTarget("forwarder");
  return (await target.client.readContract({
    address: forwarder,
    abi: target.abi,
    functionName: "sweepCount",
  })) as bigint;
}

export async function readSubscriptionCount(rsc: Address): Promise<bigint> {
  const target = contractTarget("rsc");
  return (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "subscriptionCount",
  })) as bigint;
}

export async function readNativeBalance(key: "rsc" | "forwarder"): Promise<bigint> {
  const target = contractTarget(key);
  return target.client.getBalance({ address: target.address });
}

export async function readGasPrice(): Promise<bigint> {
  return contractTarget("forwarder").client.getGasPrice();
}

/**
 * `debt(address)` on the reactive system contract or the origin callback proxy.
 *
 * Returns `null` when the read failed, never `0n`. The distinction is the whole point of the
 * budget page: `coverDebt` exists because a contract in debt is silently skipped — an RSC in debt
 * receives no reactive transactions at all, and a forwarder in debt has its callbacks rejected.
 * A swallowed failure here would render as "no debt", i.e. as the one healthy state, at exactly
 * the moment the node is too rate-limited to tell us the truth. `withRpcRetry` around this call
 * could not help while the error was caught inside it.
 */
export async function readDebt(
  kind: "system" | "callback-proxy",
  contract: Address,
): Promise<bigint | null> {
  const target = payerTarget(kind);
  try {
    // The retry lives *inside* the try, not around this function.
    //
    // Wrapping this call in `withRpcRetry` from outside cannot help: the catch below swallows
    // the transport failure first, so the retry sees a successful call that returned `null`.
    // Measured live on the public gateways, `debt()` intermittently answers "HTTP request failed"
    // while the very next attempt returns 0 — so the budget page reported `forwarderDebt: null`
    // (unreadable) for a deployment that was not in debt at all. Retrying here gives the transport
    // a chance before the read is declared unreadable.
    return (await withRpcRetry(() =>
      target.client.readContract({
        address: target.address,
        abi: target.abi,
        functionName: "debt",
        args: [contract],
      }),
    )) as bigint;
  } catch {
    return null;
  }
}

export async function readTokenBalance(token: Address, account: Address): Promise<bigint> {
  // The target is resolved *with* the token being read. The address argument below is already
  // the caller's token, but `contractTarget("token")` alone still resolves — and therefore
  // requires — `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS`, which is only the deployment's optional
  // default. Without the override this threw before the read on a multi-token deployment that
  // had no default configured.
  const target = contractTarget("token", token);
  return (await target.client.readContract({
    address: token,
    abi: target.abi,
    functionName: "balanceOf",
    args: [account],
  })) as bigint;
}

/**
 * Block height of one side of the deployment.
 *
 * `"origin"` is the token chain (also the callback destination), `"reactive"` is the
 * Reactive chain. Naming them by role rather than by chain keeps the indexers honest when
 * the deployment is pointed at a different chain.
 */
export async function readHead(kind: "origin" | "reactive"): Promise<bigint> {
  const client = kind === "origin" ? contractTarget("forwarder").client : contractTarget("rsc").client;
  return withRpcRetry(() => client.getBlockNumber());
}
