import type { AllowanceState } from "./allowance";
import type { ResidueState } from "./residue";
import type { Tone } from "./tone";

/**
 * Why a balance is still sitting in a burner.
 *
 * The ledger used to say only "reactive-only", which is a statement about the event
 * history. That is not the same as a cause, and the causes need different responses:
 * a missing allowance needs a new permit, a disarmed rule needs re-arming, and a
 * historical callback failure needs a rescue.
 */
export type StrandCauseId =
  | "resolved"
  | "below-dust-floor"
  | "allowance-missing"
  | "allowance-partial"
  | "rule-disarmed"
  | "route-inactive"
  | "cold-wallet-mismatch"
  | "preconditions-unread"
  | "not-reproducible";

export const STRAND_CAUSE_TONE: Record<StrandCauseId, Tone> = {
  resolved: "ok",
  "below-dust-floor": "warn",
  "allowance-missing": "danger",
  "allowance-partial": "warn",
  "rule-disarmed": "danger",
  "route-inactive": "danger",
  "cold-wallet-mismatch": "danger",
  "preconditions-unread": "muted",
  "not-reproducible": "info",
};

/**
 * The on-chain preconditions a sweep needs, as read at index time.
 *
 * Every field is nullable: a failed read must not be reported as "false", because
 * "the rule is disarmed" and "the rule could not be read" lead to opposite actions.
 */
export interface SweepPreconditions {
  readonly allowance: AllowanceState;
  readonly forwarderArmed: boolean | null;
  readonly rscActive: boolean | null;
  /** True when both sides name the same cold wallet, null when either is unread. */
  readonly coldWalletAgrees: boolean | null;
}

export interface StrandCause {
  readonly id: StrandCauseId;
  readonly headline: string;
  readonly detail: string;
}

/**
 * Explains a residue from the preconditions that are checkable right now.
 *
 * The checks run in the order a sweep would fail, so the reported cause is the first
 * thing that would actually stop the next sweep rather than an arbitrary one of
 * several. When nothing current explains the residue, the cause is reported as
 * `not-reproducible`: that is the honest answer for a deposit whose callback failed
 * once and whose route has since been repaired.
 */
export function explainStrand(params: {
  readonly residue: ResidueState;
  /**
   * True only when the reactive chain actually emitted `DustIgnored` for this deposit.
   *
   * It is deliberately not inferred from the amount: the dust floor is owner-editable and the
   * deposit may predate it. Absence of the event means the dust floor is *not* the answer, so
   * the other causes still have to be checked.
   */
  readonly dustIgnored: boolean;
  readonly preconditions: SweepPreconditions;
}): StrandCause {
  if (params.residue === "unread") {
    return {
      id: "preconditions-unread",
      headline: "The burner balance could not be read.",
      detail:
        "Without the balance there is nothing to explain. This is a reading failure, not evidence that the burner is empty.",
    };
  }

  if (params.residue === "cleared") {
    return {
      id: "resolved",
      headline: "Nothing is stranded.",
      detail: "The burner is empty right now, so no cause needs explaining.",
    };
  }

  // Checked before the allowance and rule checks because it is the one cause the chain has
  // already confirmed. A dust deposit never requested a callback, so a zero allowance would
  // never have been reached; reporting that instead would send the operator to fix something
  // that is not blocking this balance.
  if (params.dustIgnored) {
    return {
      id: "below-dust-floor",
      headline: "This deposit is below the dust floor, so no sweep was requested.",
      detail:
        "SapuRSC emitted DustIgnored instead of PurgeTriggered because the amount is smaller than minDeposit. The tokens really are in the burner and nothing failed. Lower the dust floor on the budget page if a deposit this small should be swept; otherwise the balance is intentionally left alone because moving it would cost more than it is worth.",
    };
  }

  const p = params.preconditions;

  if (p.allowance === "missing") {
    return {
      id: "allowance-missing",
      headline: "The allowance is zero, so every sweep for this burner reverts.",
      detail:
        "executeSweep pulls with safeTransferFrom. With no allowance the call reverts before any tokens move, and each new deposit strands the same way. The fix is a fresh permit for this burner.",
    };
  }

  if (p.forwarderArmed === false) {
    return {
      id: "rule-disarmed",
      headline: "The forwarder rule for this burner is disarmed.",
      detail:
        "A callback for this pair reverts with RouteNotArmed, so nothing can move. Re-arm the destination rule, then rescue what is already there.",
    };
  }

  if (p.rscActive === false) {
    return {
      id: "route-inactive",
      headline: "The reactive route for this burner is revoked.",
      detail:
        "With no active route the RSC returns early and never requests a callback, so no sweep is even attempted. Nothing will move until the route is registered again.",
    };
  }

  if (p.coldWalletAgrees === false) {
    return {
      id: "cold-wallet-mismatch",
      headline: "The two sides disagree about the destination wallet.",
      detail:
        "The forwarder rejects a callback whose destination differs from its armed rule with DestinationMismatch. Until both sides name the same wallet, a sweep cannot succeed.",
    };
  }

  if (p.allowance === "unread" || p.forwarderArmed === null || p.rscActive === null) {
    return {
      id: "preconditions-unread",
      headline: "Some preconditions could not be read, so no cause can be confirmed.",
      detail:
        "At least one of the allowance, the forwarder rule, or the reactive route was unreadable. Reporting a cause here would be a guess.",
    };
  }

  if (p.allowance === "insufficient") {
    return {
      id: "allowance-partial",
      headline: "The allowance covers only part of the balance.",
      detail:
        "A sweep would move what the allowance permits and leave the remainder behind, which is how a partial residue accumulates. Raising the allowance clears the rest.",
    };
  }

  return {
    id: "not-reproducible",
    headline: "Every precondition a sweep needs is currently satisfied.",
    detail:
      "The route is armed on both sides, the allowance covers the balance, and the destinations agree. The residue is therefore historical: a callback failed earlier (gas, debt, or a transient revert) and nothing has retried it. A rescue is the way to move it.",
  };
}
