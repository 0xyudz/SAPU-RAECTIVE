import type { BaseUnits } from "./burner-route";
import type { Tone } from "./tone";

/**
 * Whether a burner can still be swept, judged by the one thing that is easiest to
 * lose and hardest to notice: the standing allowance the burner granted the forwarder.
 *
 * Arming checks the allowance once. Nothing re-checks it afterwards, so a burner can
 * become unsweepable long after it was reported as armed. This type makes that state
 * visible per row instead of leaving it as a silent cause of `reactive-only`.
 */
export type AllowanceState = "granted" | "insufficient" | "missing" | "unread";

export const ALLOWANCE_TONE: Record<AllowanceState, Tone> = {
  granted: "ok",
  insufficient: "warn",
  missing: "danger",
  unread: "muted",
};

export const ALLOWANCE_NOTE: Record<AllowanceState, string> = {
  granted:
    "The burner has granted the forwarder enough allowance to move what it currently holds. A sweep can proceed.",
  insufficient:
    "The allowance is non-zero but smaller than the burner balance. The forwarder can only move part of it, so a residue would remain.",
  missing:
    "The allowance is zero. Every sweep for this burner reverts inside safeTransferFrom, so each new deposit strands.",
  unread:
    "The allowance could not be read. This is not the same as zero, and the app does not report it as zero.",
};

export interface AllowanceAssessment {
  readonly state: AllowanceState;
  /** The allowance as read, or null when the read failed. */
  readonly allowance: BaseUnits | null;
}

/**
 * Compares the live allowance against the live balance.
 *
 * The comparison is against the *balance*, not the deposit: the forwarder pulls
 * `min(amount, balance)`, so an allowance that covers the current balance is enough to
 * clear it. Reporting "granted" for a non-zero allowance that is smaller than the
 * balance would be wrong, because such a sweep leaves a remainder behind.
 */
export function assessAllowance(params: {
  readonly allowance: bigint | null;
  readonly liveBalance: bigint | null;
}): AllowanceAssessment {
  if (params.allowance === null) {
    return { state: "unread", allowance: null };
  }

  const allowance = params.allowance.toString();

  if (params.allowance === 0n) {
    return { state: "missing", allowance };
  }

  if (params.liveBalance === null) {
    // The allowance is known to be non-zero, but there is nothing to compare it
    // against. Calling that "granted" would overstate what is known.
    return { state: "unread", allowance };
  }

  return {
    state: params.allowance >= params.liveBalance ? "granted" : "insufficient",
    allowance,
  };
}

/**
 * Burners that are holding funds the forwarder is not allowed to move.
 *
 * This is the preventive signal the app was missing: a funded burner with a missing or
 * partial allowance is a deposit that will strand on the next callback, and nothing else
 * in the product reports it. Counted per burner so one burner with several deposits is
 * not counted several times.
 */
export interface StrandRisk {
  /** Distinct (token, burner) positions holding tokens whose allowance cannot move the whole balance. */
  readonly atRiskBurners: number;
  /** Distinct (token, burner) positions whose allowance could not be read while they held funds. */
  readonly unknownBurners: number;
}

export function summarizeStrandRisk(
  rows: readonly {
    readonly token?: string;
    readonly burner: string;
    readonly residue: { readonly state: string };
    readonly allowance: AllowanceAssessment;
  }[],
): StrandRisk {
  // Keyed per position. A burner armed for token A and unarmed for token B has two different
  // answers, and reporting one number per burner would have to pick one of them.
  const seen = new Map<string, { held: boolean; state: AllowanceState }>();
  for (const row of rows) {
    const key = `${(row.token ?? "").toLowerCase()}:${row.burner.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.set(key, { held: row.residue.state === "held", state: row.allowance.state });
  }

  let atRiskBurners = 0;
  let unknownBurners = 0;
  for (const entry of seen.values()) {
    if (!entry.held) continue;
    if (entry.state === "missing" || entry.state === "insufficient") atRiskBurners += 1;
    else if (entry.state === "unread") unknownBurners += 1;
  }

  return { atRiskBurners, unknownBurners };
}
