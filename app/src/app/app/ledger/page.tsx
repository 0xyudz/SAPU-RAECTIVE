"use client";

import { useState } from "react";
import { POLL_INTERVAL_MS } from "@/config/constants";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { ForwarderCapabilities } from "@/infrastructure/forwarder-capabilities";
import type { Address } from "@/domain/burner-route";
import {
  LEDGER_STATUSES,
  LEDGER_STATUS_NOTE,
  LEDGER_STATUS_TONE,
  type LedgerLegView,
  type LedgerRow,
} from "@/domain/ledger";
import { formatAmount } from "@/domain/sweep-receipt";
import { rescueResidue } from "@/application/rescue-service";
import { createRescueWriter } from "@/infrastructure/rescue-writer";
import { LiveBadge, probeState } from "@/components/live-badge";
import { StatCard } from "@/components/stat-card";
import { ResidueCell, ResidueLegend, ResidueStat } from "@/components/residue-cell";
import { AllowanceCell, AllowanceLegend, StrandRiskCard } from "@/components/budget-alert";
import { StrandCauseCell, StrandCauseLegend } from "@/components/strand-cause-cell";
import { RescueAction, rescueAvailability } from "@/components/rescue-action";
import { PreflightPanel } from "@/components/preflight-panel";
import { FailureReport, ProofDrawer } from "@/components/proof-drawer";
import { ErrorNote, PendingNote, StatusPill } from "@/components/primitives";
import { shortAddress, shortHash, plural } from "@/components/short-value";
import { useApi } from "@/components/use-api";
import { useSurfaceMode } from "@/components/surface-mode";
import { useWallet } from "../wallet";
import { useWriteGate } from "../use-write";

/** What `/api/ledger` adds on top of the index: who can rescue, and whether they can. */
interface LedgerResponse extends LedgerIndex {
  readonly forwarderOwner: Address | null;
  readonly capabilities: ForwarderCapabilities;
}

/**
 * How long a deposit waited for its sweep.
 *
 * The raw delta is honest but reads as a verdict. One sweep transaction can clear several
 * deposits at once, so the *last* deposit in a batch carries the whole wait: the live ledger
 * showed rows of 1 079 000 ms and 1 110 000 ms — printed as "1079.0 s" — for a loop whose real
 * round trip is 1.0 s. A visitor reads that as a broken system, which is the opposite of the
 * truth, so anything past a minute is reported in minutes and named as batched.
 */
function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = ms / 60_000;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`;
}

/** True when a wait is long enough that the cause is a shared sweep, not a slow loop. */
function isBatchedWait(ms: number | null): boolean {
  return ms !== null && ms >= 60_000;
}

function formatTimestamp(ts: number): string {
  if (ts <= 0) return "timestamp —";
  return `${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function LegCell({ leg, missing }: { leg: LedgerLegView | null; missing: string }) {
  if (leg === null) {
    return (
      <span className="font-mono text-[10.5px] text-slate-600" title={missing}>
        {missing}
      </span>
    );
  }
  return (
    <div className="space-y-0.5">
      <a
        href={leg.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="block font-mono text-[11px] text-slate-400 underline decoration-steel-bright underline-offset-2 hover:text-lime-glow"
        title={`${leg.txHash} · block ${leg.blockNumber}`}
      >
        {shortHash(leg.txHash)} ↗
        <span className="ml-1 text-slate-600">blk {leg.blockNumber}</span>
      </a>
      <span className="block font-mono text-[10px] text-slate-600">{formatTimestamp(leg.timestamp)}</span>
    </div>
  );
}

/** A set of ledger rows that share one sweep transaction, in the order the API returned them. */
interface RowGroup {
  readonly key: string;
  readonly sweepHash: string | null;
  readonly rows: LedgerRow[];
}

/**
 * Groups rows by the sweep transaction that cleared them.
 *
 * One sweep can clear several deposits, and the ledger used to render those as unrelated
 * rows: four rows each showing the same sweep hash, three of them reporting a wait of
 * several minutes. Grouping them says the true thing — this one transaction cleared all of
 * these — and turns the long latency from an accusation into an explanation.
 *
 * Only consecutive rows merge, so the API's ordering is never silently reshuffled.
 */
function groupRows(rows: readonly LedgerRow[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    const sweepHash = row.sweep?.txHash ?? null;
    const last = groups[groups.length - 1];
    if (last !== undefined && sweepHash !== null && last.sweepHash === sweepHash) {
      last.rows.push(row);
      continue;
    }
    groups.push({ key: `${sweepHash ?? row.id}:${row.token}:${row.burner}`, sweepHash, rows: [row] });
  }
  return groups;
}

function LedgerRowView({
  row,
  decimals,
  symbol,
  reactiveScanFailed,
  originScanFailed,
  rescue,
  showAllowance,
  showCause,
  showRecover,
  sweepSharedWith,
}: {
  row: LedgerRow;
  decimals: number | null;
  symbol: string;
  reactiveScanFailed: boolean;
  originScanFailed: boolean;
  rescue: React.ReactNode;
  /** Hidden in simple mode and whenever no row needs them; see `LedgerPage`. */
  showAllowance: boolean;
  showCause: boolean;
  showRecover: boolean;
  /** How many deposits this row's sweep transaction cleared, or null when it cleared only this one. */
  sweepSharedWith: number | null;
}) {
  return (
    <tr className="border-b border-steel/40 align-top hover:bg-steel/20">
      <td className="px-4 py-3">
        <StatusPill label={row.status} tone={LEDGER_STATUS_TONE[row.status]} />
      </td>
      <td className="px-4 py-3 font-mono text-[11.5px]">
        <span className="block text-slate-200">
          {formatAmount(row.depositAmount, decimals, symbol)}
        </span>
        <span className="mt-0.5 block text-[10px] text-slate-600">
          swept {formatAmount(row.sweptAmount, decimals, symbol)}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[11.5px]">
        <span className="block text-slate-300" title={row.token}>
          {symbol}
        </span>
        <span className="mt-0.5 block text-[10px] text-slate-600" title={row.token}>
          {shortAddress(row.token)}
        </span>
      </td>
      <td className="px-4 py-3">
        <LegCell leg={row.deposit} missing={originScanFailed ? "deposit logs unreadable" : "no deposit"} />
      </td>
      <td className="px-4 py-3">
        <LegCell
          leg={row.reactive}
          missing={reactiveScanFailed ? "reactive logs unreadable" : "no reactive proof"}
        />
      </td>
      <td className="px-4 py-3">
        <LegCell
          leg={row.sweep}
          missing={originScanFailed ? "sweep logs unreadable" : "awaiting sweep"}
        />
      </td>
      <td
        className="px-4 py-3 font-mono text-[11px] text-slate-400"
        title={
          isBatchedWait(row.latencyMs)
            ? "One sweep transaction cleared several deposits, so this row waited for the last of them. The loop itself runs in about a second."
            : undefined
        }
      >
        {formatLatency(row.latencyMs)}
        {sweepSharedWith !== null && (
          <span className="mt-0.5 block text-[9.5px] text-slate-600">
            one sweep cleared {sweepSharedWith}
          </span>
        )}
        {sweepSharedWith === null && isBatchedWait(row.latencyMs) && (
          <span className="mt-0.5 block text-[9.5px] text-slate-600">batched sweep</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-[11px]">
        <span className="block text-slate-300" title={row.burner}>
          {shortAddress(row.burner)}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.coldWallet ?? undefined}>
          {row.coldWallet ? shortAddress(row.coldWallet) : "cold wallet unobserved"}
        </span>
      </td>
      <td className="px-4 py-3">
        <ResidueCell residue={row.residue} decimals={decimals} symbol={symbol} />
      </td>
      {showAllowance && (
        <td className="px-4 py-3">
          <AllowanceCell assessment={row.allowance} symbol={symbol} />
        </td>
      )}
      {showCause && (
        <td className="px-4 py-3">
          <StrandCauseCell cause={row.cause} />
        </td>
      )}
      {showRecover && <td className="px-4 py-3">{rescue}</td>}
    </tr>
  );
}

export default function LedgerPage() {
  const ledger = useApi<LedgerResponse>("/api/ledger", POLL_INTERVAL_MS.ledger);
  const { wallet } = useWallet();
  const gate = useWriteGate();
  const [busy, setBusy] = useState<string | null>(null);
  const index = ledger.data;
  /**
   * Whether the reactive leg was actually scanned.
   *
   * Taken from the index's structural `coverage`, not from a regex over `index.error`. The regex
   * covered two of the five failure shapes, so a failed reactive *head* — which skips every
   * reactive query — left every row labelled "no reactive proof", which is a claim about the
   * chain rather than about the scan.
   */
  const reactiveScanFailed = index !== null && !index.coverage.reactiveEvents;
  const originScanFailed = index !== null && !index.coverage.originEvents;

  // Metadata comes from the chain per token, never from configuration: a row's amount must be
  // rendered with the decimals of the token it actually is, or the ledger prints a confident
  // wrong number for every asset except the one the env file happened to name.
  const metaFor = (token: string) =>
    index?.tokens.find((entry) => entry.token.toLowerCase() === token.toLowerCase()) ?? null;
  // Null rather than 0: a row whose decimals are unreadable must render as raw base units, and `0`
  // is a real scale (a 0-decimal token) that would print the integer as if it were scaled.
  const decimalsFor = (token: string) => metaFor(token)?.decimals ?? null;
  const symbolFor = (token: string) => {
    const meta = metaFor(token);
    if (meta?.symbol) return meta.symbol;
    return `${token.slice(0, 6)}…${token.slice(-4)}`;
  };

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isForwarderOwner = walletAddress !== null && walletAddress === index?.forwarderOwner;

  const { mode } = useSurfaceMode();

  /**
   * Which optional columns earn their width.
   *
   * "why stranded" and "recover" exist for rows that have something stuck in them. On a
   * healthy deployment every row is `complete` and both columns are a full column of dashes:
   * twelve columns of which two say nothing, which is how a table stops being readable. They
   * are rendered when at least one row actually needs them — a real fact, not a mode toggle —
   * and the allowance column, which only explains whether a *future* sweep could move a
   * residue, follows the same rule. Operator mode shows all three regardless.
   */
  const anyHeld = index !== null && index.rows.some((row) => row.residue.state === "held");
  const anyUnread = index !== null && index.rows.some((row) => row.residue.state === "unread");
  const anyCause = index !== null && index.rows.some((row) => row.cause.id !== "resolved");
  const showAllowance = mode === "operator" || anyHeld || anyUnread;
  const showCause = mode === "operator" || anyCause;
  const showRecover = mode === "operator" || anyHeld;

  const runRescue = async (row: LedgerRow) => {
    // The live rule's destination, not the event's. `rescueSweep` uses `rule.coldWallet` on
    // chain, so this is the only value that can back the "destination" line the operator
    // approves. A null rule is blocked by `rescueAvailability` before this is reachable.
    if (!index?.forwarder || row.liveColdWallet === null) return;
    gate.reset();
    setBusy(`${row.token}:${row.burner}`);
    try {
      await rescueResidue(
        createRescueWriter(),
        {
          forwarder: index.forwarder,
          token: row.token as Address,
          burner: row.burner as Address,
          coldWallet: row.liveColdWallet as Address,
          residue: row.residue,
        },
        gate.options,
      );
    } finally {
      setBusy(null);
    }
    ledger.refresh();
  };

  const availabilityFor = (row: LedgerRow) =>
    rescueAvailability({
      supported: index?.capabilities.rescueSweep ?? null,
      residue: row.residue,
      coldWallet: row.liveColdWallet,
    });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Sweep Ledger</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            One row per observed deposit, joined across the three legs of the loop. A row is complete only when all
            three legs are real events; the two incomplete statuses are kept distinct. The last two columns are read
            live: history says what happened, the burner balance says what is still there.
          </p>
        </div>
        <LiveBadge
          state={probeState(index, ledger.error, ledger.loading)}
          detail={
            ledger.error ??
            (index
              ? plural(index.rows.length, "row")
              : ledger.loading
                ? "scanning event history…"
                : "no ledger payload")
          }
        />
      </header>

      {(ledger.error ?? index?.error) && <ErrorNote>{ledger.error ?? index?.error}</ErrorNote>}

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} />
      <FailureReport
        reason={gate.failure?.reason ?? null}
        decoded={gate.failure?.decoded}
        onClear={gate.clearFailure}
      />
      <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="complete"
          value={index?.counts.complete.toString() ?? "—"}
          detail="deposit → reactive → sweep"
          tone="ok"
        />
        <StatCard
          label="reactive-only"
          value={index?.counts.reactiveOnly.toString() ?? "—"}
          detail="deposit seen, no sweep followed"
          tone="warn"
        />
        <StatCard
          label="orphan-sweep"
          value={index?.counts.orphanSweep.toString() ?? "—"}
          detail="sweep with no deposit in window"
          tone="muted"
        />
        {index ? (
          <ResidueStat summary={index.residue} decimalsFor={decimalsFor} symbolFor={symbolFor} />
        ) : (
          <StatCard label="still in burners" value="—" detail="reading burner balances…" tone="muted" />
        )}
        {index ? (
          <StrandRiskCard risk={index.strandRisk} />
        ) : (
          <StatCard label="blocked by approval" value="—" detail="reading allowances…" tone="muted" />
        )}
      </section>

      {index !== null && (!index.coverage.originEvents || !index.coverage.reactiveEvents) && (
        <p className="font-mono text-[10.5px] leading-relaxed text-amber-500">
          Incomplete scan:{" "}
          {[
            index.coverage.originEvents ? null : "origin-chain logs",
            index.coverage.reactiveEvents ? null : "reactive-chain logs",
          ]
            .filter((part): part is string => part !== null)
            .join(" and ")}{" "}
          could not be read. The counts above are a lower bound over the legs that did answer, not a
          complete history — an empty or small table here is not proof that nothing happened.
        </p>
      )}

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steel/70 px-4 py-3">
          <p className="label-caps">Ledger</p>
          {index && (
            <p className="font-mono text-[10px] text-slate-600">
              base {index.window.originFrom ?? "?"}–{index.window.originTo ?? "?"} · reactive{" "}
              {index.window.reactiveFrom ?? "?"}–{index.window.reactiveTo ?? "?"}
            </p>
          )}
        </div>

        {index === null ? (
          // `ledger.loading` distinguishes "the request is still running" from "the request
          // finished and there is still no payload" (a failed fetch leaves `data` null). Showing
          // "scanning…" forever in the failure case hides that nothing is being scanned.
          <PendingNote>
            {ledger.loading ? "Scanning event history…" : (ledger.error ?? "No ledger payload was returned.")}
          </PendingNote>
        ) : !index.configured ? (
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            {index.error ?? "Deployment addresses are not configured."}
          </p>
        ) : index.rows.length === 0 ? (
          // An empty result is only evidence of absence when the window was actually covered.
          // Never print a bare "no deposits or sweeps" for a scan that did not reach a head.
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            {index.coverage.reactiveEvents && index.coverage.originEvents
              ? "No deposits or sweeps in the scanned window. That is an observation, not an invented row."
              : `The scan did not cover every leg, so this empty table is not evidence that nothing happened. ${
                  index.error ?? ""
                }`.trim()}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`w-full text-left ${showRecover || showCause ? "min-w-[76rem]" : "min-w-[62rem]"}`}>
              <thead className="border-b border-steel/60 font-mono text-[10.5px] uppercase tracking-wide text-slate-600">
                <tr>
                  {/* Ordered as the story is told: what happened, how much, to which asset,
                      when each leg landed, how long it took, then where it went. */}
                  <th className="px-4 py-2 font-normal">status</th>
                  <th className="px-4 py-2 font-normal">amount</th>
                  <th className="px-4 py-2 font-normal">token</th>
                  <th className="px-4 py-2 font-normal">deposit</th>
                  <th className="px-4 py-2 font-normal">reactive</th>
                  <th className="px-4 py-2 font-normal">sweep</th>
                  <th className="px-4 py-2 font-normal">latency</th>
                  <th className="px-4 py-2 font-normal">burner / cold</th>
                  <th className="px-4 py-2 font-normal">in burner now</th>
                  {showAllowance && <th className="px-4 py-2 font-normal">allowance</th>}
                  {showCause && <th className="px-4 py-2 font-normal">why stranded</th>}
                  {showRecover && <th className="px-4 py-2 font-normal">recover</th>}
                </tr>
              </thead>
              <tbody>
                {groupRows(index.rows).map((group) =>
                  group.rows.map((row, position) => (
                    <LedgerRowView
                      key={`${row.id}:${row.token}:${row.burner}`}
                      row={row}
                      decimals={decimalsFor(row.token)}
                      symbol={symbolFor(row.token)}
                      reactiveScanFailed={reactiveScanFailed}
                      originScanFailed={originScanFailed}
                      showAllowance={showAllowance}
                      showCause={showCause}
                      showRecover={showRecover}
                      sweepSharedWith={position === 0 && group.rows.length > 1 ? group.rows.length : null}
                      rescue={
                        <RescueAction
                          availability={availabilityFor(row)}
                          busy={busy === `${row.token}:${row.burner}`}
                          walletConnected={wallet.address !== null}
                          isOwner={isForwarderOwner}
                          onRescue={() => void runRescue(row)}
                        />
                      }
                    />
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* The legends explain columns that are on screen. Explaining two states nobody can
          reach makes the page longer without making it clearer, so they follow the columns. */}
      {showCause && (
        <section className="panel p-5">
          <p className="label-caps">How to read the cause</p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
            The checks run in the order a sweep would hit them, so the reported cause is the first
            thing that would actually stop the next sweep. Hover a cell for the full explanation.
          </p>
          <StrandCauseLegend />
        </section>
      )}

      <section className="panel p-5">
        <p className="label-caps">How to read the statuses</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {LEDGER_STATUSES.map((status) => (
            <div key={status}>
              <StatusPill label={status} tone={LEDGER_STATUS_TONE[status]} />
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{LEDGER_STATUS_NOTE[status]}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel p-5">
        <p className="label-caps">How to read the burner balance</p>
        <ResidueLegend />
      </section>

      {showAllowance && (
        <section className="panel p-5">
          <p className="label-caps">How to read the allowance</p>
          <AllowanceLegend />
        </section>
      )}
    </div>
  );
}
