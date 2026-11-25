import type { Residue, ResidueSummary } from "@/domain/residue";
import { RESIDUE_NOTE, RESIDUE_STATES, RESIDUE_TONE } from "@/domain/residue";
import { formatAmount } from "@/domain/sweep-receipt";
import { StatusPill } from "./primitives";
import { StatCard } from "./stat-card";
import { TONE_TEXT } from "./tone";

/**
 * Present-tense burner balance for one ledger row.
 *
 * Deliberately separate from the status column: status is a historical claim
 * ("a sweep event exists"), residue is a present one ("the burner is empty now").
 * A row can be `reactive-only` and `cleared`, or `complete` and `held`.
 */
export function ResidueCell({
  residue,
  decimals,
  symbol,
}: {
  residue: Residue;
  /** Null means `decimals()` was not read; the amount is then printed as raw base units. */
  decimals: number | null;
  symbol: string;
}) {
  if (residue.state === "unread" || residue.liveBalance === null) {
    return (
      <div className="space-y-0.5">
        <span className="font-mono text-[11px] text-amber-500" title={RESIDUE_NOTE.unread}>
          unread
        </span>
        <span className="block font-mono text-[10px] text-amber-600/70">balance read failed</span>
      </div>
    );
  }

  // A scale that could not be read is not a scale of zero: `formatAmount` names the unit instead
  // of letting the integer pass for a scaled amount.
  const live = formatAmount(residue.liveBalance, decimals, symbol);

  if (residue.state === "cleared") {
    return (
      <div className="space-y-0.5">
        <span className="font-mono text-[11px] text-slate-400" title={RESIDUE_NOTE.cleared}>
          0 {symbol}
        </span>
        <span className="block font-mono text-[10px] text-slate-600">burner empty</span>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <span className="font-mono text-[11px] text-red-300" title={RESIDUE_NOTE.held}>
        {live}
      </span>
      <span className="block font-mono text-[10px] text-red-400/70">still in burner</span>
    </div>
  );
}

/**
 * Header card for live balances.
 *
 * There is deliberately no single grand total. Base units of different tokens are not
 * comparable — adding 6-decimal USDC to 18-decimal SAPU produces a number that means nothing —
 * so each token is printed with its own decimals, and any token whose reads were incomplete has
 * its total withheld rather than reported as a lower bound.
 */
export function ResidueStat({
  summary,
  decimalsFor,
  symbolFor,
}: {
  summary: ResidueSummary;
  /** Decimals per token, from the token contract. Null means unreadable, not 18. */
  decimalsFor: (token: string) => number | null;
  symbolFor: (token: string) => string;
}) {
  const withheld = summary.totals.filter((entry) => entry.totalHeld === null);
  const detail =
    summary.unreadBurners > 0
      ? `${summary.unreadBurners} position balance(s) unreadable — total withheld`
      : summary.heldBurners === 0
        ? "every known burner is empty"
        : `${summary.heldBurners} position(s) still funded`;

  const rendered = summary.totals
    .filter((entry) => entry.totalHeld !== null)
    .map((entry) => formatAmount(entry.totalHeld, decimalsFor(entry.token), symbolFor(entry.token)));

  const value =
    summary.totals.length === 0
      ? "0"
      : rendered.length === 0
        ? "—"
        : rendered.join(" · ");

  return (
    <StatCard
      label="still in burners"
      value={value}
      detail={
        withheld.length > 0 && rendered.length > 0
          ? `${detail} (${withheld.length} token(s) withheld)`
          : detail
      }
      tone={summary.heldBurners > 0 ? "danger" : summary.unreadBurners > 0 ? "warn" : "ok"}
    />
  );
}

/** Legend so the three residue states are explained, not just coloured. */
export function ResidueLegend() {
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-3">
      {RESIDUE_STATES.map((state) => (
        <div key={state}>
          <StatusPill label={state} tone={RESIDUE_TONE[state]} />
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{RESIDUE_NOTE[state]}</p>
        </div>
      ))}
      <p className={`md:col-span-3 font-mono text-[10px] ${TONE_TEXT.muted}`}>
        Balances are read from the token contract at index time via multicall, in the same scan as the
        event history. They describe the present, not the scanned window.
      </p>
    </div>
  );
}
