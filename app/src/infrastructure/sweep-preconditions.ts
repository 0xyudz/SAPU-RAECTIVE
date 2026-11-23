import type { Address } from "@/domain/burner-route";
import type { SweepPreconditions } from "@/domain/strand-cause";
import type { AllowanceState } from "@/domain/allowance";
import { contractTarget } from "./contracts";
import { decode, encode, multicall } from "./multicall";

/**
 * The on-chain state a sweep depends on, read per burner.
 *
 * The forwarder rule and the reactive route live on two different chains, so they are
 * read in two batches. Any sub-call that fails becomes `null` rather than `false`:
 * "the rule is disarmed" and "the rule could not be read" lead to opposite actions,
 * and collapsing them would make the ledger prescribe the wrong repair.
 */
export interface PreconditionReads {
  readonly forwarderArmed: boolean | null;
  readonly forwarderColdWallet: Address | null;
  readonly rscActive: boolean | null;
  readonly rscColdWallet: Address | null;
}

function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

export async function readPreconditions(params: {
  readonly forwarder: Address;
  readonly rsc: Address;
  readonly token: Address;
  readonly burners: readonly Address[];
}): Promise<ReadonlyMap<Address, PreconditionReads>> {
  const unique = [...new Set(params.burners.map((burner) => burner.toLowerCase() as Address))];
  const out = new Map<Address, PreconditionReads>();
  if (unique.length === 0) return out;

  const forwarder = contractTarget("forwarder");
  const rsc = contractTarget("rsc");

  const [ruleResults, routeResults] = await Promise.all([
    multicall(
      unique.map((burner) => ({
        target: params.forwarder,
        callData: encode(forwarder.abi, "ruleOf", [params.token, burner]),
      })),
      "base",
    ).catch(() => unique.map(() => null)),
    multicall(
      unique.map((burner) => ({
        target: params.rsc,
        callData: encode(rsc.abi, "routeOf", [params.token, burner]),
      })),
      "reactive",
    ).catch(() => unique.map(() => null)),
  ]);

  for (const [index, burner] of unique.entries()) {
    out.set(burner, {
      ...readRule(ruleResults[index] ?? null),
      ...readRoute(routeResults[index] ?? null),
    });
  }

  return out;
}

function readRule(data: `0x${string}` | null): { forwarderArmed: boolean | null; forwarderColdWallet: Address | null } {
  if (data === null || data === "0x") return { forwarderArmed: null, forwarderColdWallet: null };
  try {
    const rule = decode<{ coldWallet: Address; armed: boolean }>(contractTarget("forwarder").abi, "ruleOf", data);
    return {
      forwarderArmed: rule.armed,
      forwarderColdWallet: rule.armed ? lower(rule.coldWallet) : null,
    };
  } catch {
    return { forwarderArmed: null, forwarderColdWallet: null };
  }
}

function readRoute(data: `0x${string}` | null): { rscActive: boolean | null; rscColdWallet: Address | null } {
  if (data === null || data === "0x") return { rscActive: null, rscColdWallet: null };
  try {
    const route = decode<{ coldWallet: Address; active: boolean }>(contractTarget("rsc").abi, "routeOf", data);
    return {
      rscActive: route.active,
      rscColdWallet: route.active ? lower(route.coldWallet) : null,
    };
  } catch {
    return { rscActive: null, rscColdWallet: null };
  }
}

/**
 * Turns the raw reads plus an allowance state into the shape the explanation needs.
 *
 * The cold wallets only "agree" when both sides are readable and active; otherwise the
 * answer is unknown, because a disagreement between an active rule and a revoked route
 * is already covered by the route check.
 */
export function toPreconditions(
  reads: PreconditionReads,
  allowance: AllowanceState,
): SweepPreconditions {
  const coldWalletAgrees =
    reads.forwarderColdWallet === null || reads.rscColdWallet === null
      ? null
      : reads.forwarderColdWallet === reads.rscColdWallet;

  return {
    allowance,
    forwarderArmed: reads.forwarderArmed,
    rscActive: reads.rscActive,
    coldWalletAgrees,
  };
}
