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
    const owner = (await target.client.readContract({
      address: target.address,
      abi: target.abi,
      functionName: "owner",
    })) as string;
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

export async function readDebt(kind: "system" | "callback-proxy", contract: Address): Promise<bigint> {
  const target = payerTarget(kind);
  try {
    return (await target.client.readContract({
      address: target.address,
      abi: target.abi,
      functionName: "debt",
      args: [contract],
    })) as bigint;
  } catch {
    return 0n;
  }
}

export async function readTokenBalance(token: Address, account: Address): Promise<bigint> {
  const target = contractTarget("token");
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
