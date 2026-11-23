/**
 * Decides whether losing this tab's burner key would cost something.
 *
 * The `beforeunload` guard is deliberately not a nag: it is armed only while the loss would
 * actually matter. A tab full of freshly generated, empty, unarmed burners closes silently —
 * those keys are cheap to regenerate and nothing on-chain refers to them.
 *
 * Three inputs, and the ordering between them is the whole point:
 *
 *  - no key in this tab -> nothing to lose (the address alone is not a secret, and the app
 *    can still inspect or resume an already-armed route);
 *  - balance unreadable -> treat as funded. "Unknown" must never be rendered as "empty",
 *    because that would silently disarm the guard on exactly the burners it exists for;
 *  - balance above zero -> at risk regardless of arming, since nothing on-chain will ever
 *    move that balance out once the key is gone;
 *  - armed but empty -> still at risk, because the route and its allowance are live state
 *    that the key is needed to change or unwind.
 *
 * Pure and dependency-free so the rule can be tested without a browser.
 */
export type KeyRiskReason = "no-key" | "empty-and-disarmed" | "funded" | "armed" | "balance-unknown";

export interface KeyRiskInput {
  readonly holdsKey: boolean;
  /** True only when the chain says both the route and the forwarder rule are active. */
  readonly armed: boolean;
  /** Live balance in base units as a decimal string, or null when the read failed. */
  readonly balance: string | null;
}

export interface KeyRiskVerdict {
  readonly atRisk: boolean;
  readonly reason: KeyRiskReason;
}

export function assessKeyRisk(input: KeyRiskInput): KeyRiskVerdict {
  if (!input.holdsKey) return { atRisk: false, reason: "no-key" };

  if (input.balance === null) return { atRisk: true, reason: "balance-unknown" };

  if (!/^\d+$/.test(input.balance)) return { atRisk: true, reason: "balance-unknown" };

  if (BigInt(input.balance) > 0n) return { atRisk: true, reason: "funded" };

  if (input.armed) return { atRisk: true, reason: "armed" };

  return { atRisk: false, reason: "empty-and-disarmed" };
}
