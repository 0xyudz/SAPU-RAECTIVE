import type { SweepBudget } from "./budget";
import type { Tone } from "./tone";

/**
 * How urgent a budget state is.
 *
 * Three levels rather than a boolean because "the loop will stop soon" and "the loop
 * has already stopped" need different operator responses: one is a top-up, the other
 * is a top-up plus an investigation into what failed while it was down.
 */
export type BudgetLevel = "healthy" | "low" | "exhausted" | "unknown";

export const BUDGET_LEVEL_TONE: Record<BudgetLevel, Tone> = {
  healthy: "ok",
  low: "warn",
  exhausted: "danger",
  unknown: "muted",
};

/**
 * A sweep budget below this many remaining sweeps is reported as low.
 *
 * 25 is a policy choice, not a chain fact: it is roughly a day of casual use at the
 * observed deposit rate, which is enough warning to top up before the loop stops.
 */
export const LOW_SWEEPS_THRESHOLD = 25n;

export interface BudgetWarning {
  readonly level: BudgetLevel;
  readonly headline: string;
  readonly detail: string;
}

export interface DebtState {
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
}

/**
 * Turns a live budget reading into an explicit warning.
 *
 * `sweepsRemaining` is only meaningful when the cost per sweep is known and non-zero.
 * A zero gas price would divide by zero and a zero gas limit would make the cost zero,
 * so both are reported as `unknown` rather than as an infinite budget.
 */
export function assessBudget(budget: SweepBudget, debt: DebtState): BudgetWarning {
  if (debt.rscDebt > 0n) {
    return {
      level: "exhausted",
      headline: "The RSC is in debt and is not receiving reactive transactions.",
      detail:
        "The loop is not watching at all right now. coverDebt() on the RSC is permissionless, so anyone can settle it, but nothing does so automatically.",
    };
  }

  if (debt.forwarderDebt > 0n) {
    return {
      level: "exhausted",
      headline: "The forwarder is in debt, so callbacks are being rejected before delivery.",
      detail:
        "Sweeps stop even though the RSC still triggers them. coverDebt() on the forwarder is permissionless.",
    };
  }

  if (budget.gasLimit === 0n || budget.gasPriceWei === 0n) {
    return {
      level: "unknown",
      headline: "The cost per sweep cannot be computed from the current readings.",
      detail:
        "Either the callback gas limit or the gas price read as zero, so a remaining-sweeps count would be a guess. The balance is real; the runway is not known.",
    };
  }

  if (budget.sweepsRemaining === 0n) {
    return {
      level: "exhausted",
      headline: "The forwarder cannot pay for a single further callback.",
      detail:
        "The next deposit will strand in its burner because the proxy rejects the callback for lack of funds.",
    };
  }

  if (budget.sweepsRemaining < LOW_SWEEPS_THRESHOLD) {
    return {
      level: "low",
      headline: `Only ${budget.sweepsRemaining.toString()} sweep(s) of budget remain.`,
      detail:
        "Top up the forwarder balance before it reaches zero, otherwise the next deposits will strand.",
    };
  }

  return {
    level: "healthy",
    headline: `${budget.sweepsRemaining.toString()} sweeps of budget remain.`,
    detail: "The forwarder can pay for callbacks at the current gas limit and gas price.",
  };
}
