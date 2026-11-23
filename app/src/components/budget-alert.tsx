import type { BudgetWarning } from "@/domain/budget-warning";
import { BUDGET_LEVEL_TONE } from "@/domain/budget-warning";
import type { AllowanceAssessment, StrandRisk } from "@/domain/allowance";
import { ALLOWANCE_NOTE, ALLOWANCE_TONE } from "@/domain/allowance";
import { StatusPill } from "./primitives";
import { StatCard } from "./stat-card";
import { TONE_TEXT } from "./tone";

/**
 * The budget banner.
 *
 * Renders nothing for a healthy budget so the page does not spend attention on the
 * normal case, and always renders the headline plus the reason for anything else.
 */
export function BudgetAlert({ warning }: { warning: BudgetWarning }) {
  if (warning.level === "healthy") return null;

  return (
    <section
      className="panel border-l-2 px-4 py-3"
      style={{ borderLeftColor: "currentColor" }}
      role="status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill label={warning.level} tone={BUDGET_LEVEL_TONE[warning.level]} />
        <p className={`font-mono text-[11.5px] ${TONE_TEXT[BUDGET_LEVEL_TONE[warning.level]]}`}>
          {warning.headline}
        </p>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{warning.detail}</p>
    </section>
  );
}

/** Allowance state for one ledger row, with the reason attached as a tooltip. */
export function AllowanceCell({ assessment, symbol }: { assessment: AllowanceAssessment; symbol: string }) {
  if (assessment.state === "unread" || assessment.allowance === null) {
    return (
      <span className="font-mono text-[10px] text-slate-600" title={ALLOWANCE_NOTE.unread}>
        unread
      </span>
    );
  }

  if (assessment.state === "missing") {
    return (
      <span className="font-mono text-[10px] text-red-300" title={ALLOWANCE_NOTE.missing}>
        zero allowance
      </span>
    );
  }

  if (assessment.state === "insufficient") {
    return (
      <span className="font-mono text-[10px] text-amber-500" title={ALLOWANCE_NOTE.insufficient}>
        partial
      </span>
    );
  }

  return (
    <span className="font-mono text-[10px] text-lime" title={`${ALLOWANCE_NOTE.granted} ${symbol}`}>
      covers balance
    </span>
  );
}

export function StrandRiskCard({ risk }: { risk: StrandRisk }) {
  const total = risk.atRiskBurners + risk.unknownBurners;
  // This card measures exactly one thing: whether the forwarder's allowance can move the
  // whole balance. It must not claim the funds *will* move. On a deployment without
  // `rescueSweep`, a funded burner with a perfect allowance is still stuck — and saying
  // "can be moved" beside a non-zero "still in burners" figure would be a false claim.
  const detail =
    total === 0
      ? "allowance covers every funded burner — nothing is blocked by an approval"
      : risk.unknownBurners > 0
        ? `${risk.unknownBurners} burner(s) unreadable — count is a lower bound`
        : "funded, but the allowance cannot move it";

  return (
    <StatCard
      label="blocked by approval"
      value={total.toString()}
      detail={detail}
      tone={risk.atRiskBurners > 0 ? "danger" : risk.unknownBurners > 0 ? "muted" : "ok"}
    />
  );
}

/** Explains the four allowance states so the column is readable without a legend hunt. */
export function AllowanceLegend() {
  const states = ["granted", "insufficient", "missing", "unread"] as const;
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      {states.map((state) => (
        <div key={state}>
          <StatusPill label={state} tone={ALLOWANCE_TONE[state]} />
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{ALLOWANCE_NOTE[state]}</p>
        </div>
      ))}
    </div>
  );
}
