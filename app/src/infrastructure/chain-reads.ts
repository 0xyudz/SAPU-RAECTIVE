import type { Address } from "@/domain/burner-route";
import { contractTarget, payerTarget } from "./contracts";

export function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

export interface RouteRead {
  readonly coldWallet: Address;
  readonly active: boolean;
  readonly registeredBlock: bigint;
}

export interface RuleRead {
  readonly coldWallet: Address;
  readonly armed: boolean;
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

export async function readRule(forwarder: Address, token: Address, burner: Address): Promise<RuleRead> {
  const target = contractTarget("forwarder");
  const rule = (await target.client.readContract({
    address: forwarder,
    abi: target.abi,
    functionName: "ruleOf",
    args: [token, burner],
  })) as { coldWallet: Address; armed: boolean };
  return { coldWallet: lower(rule.coldWallet), armed: rule.armed };
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

export async function readAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  const target = contractTarget("token");
  return (await target.client.readContract({
    address: token,
    abi: target.abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

export async function readCallbackGasLimit(rsc: Address): Promise<bigint> {
  const target = contractTarget("rsc");
  return (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "callbackGasLimit",
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

export async function readTokensOf(rsc: Address, burner: Address): Promise<readonly Address[]> {
  const target = contractTarget("rsc");
  const tokens = (await target.client.readContract({
    address: rsc,
    abi: target.abi,
    functionName: "tokensOf",
    args: [burner],
  })) as Address[];
  return tokens.map(lower);
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

export async function readTokenMeta(token: Address): Promise<{ name: string; symbol: string; decimals: number }> {
  const target = contractTarget("token");
  const [name, symbol, decimals] = await Promise.all([
    target.client.readContract({
      address: token,
      abi: target.abi,
      functionName: "name",
    }) as Promise<string>,
    target.client.readContract({
      address: token,
      abi: target.abi,
      functionName: "symbol",
    }) as Promise<string>,
    target.client.readContract({
      address: token,
      abi: target.abi,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  return { name, symbol, decimals: Number(decimals) };
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

export async function readHead(kind: "base" | "reactive"): Promise<bigint> {
  return kind === "base"
    ? contractTarget("forwarder").client.getBlockNumber()
    : contractTarget("rsc").client.getBlockNumber();
}
