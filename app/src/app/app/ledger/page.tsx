"use client";

import { readDeploymentConfig } from "@/config/chains";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { LedgerLegView, LedgerRow, LedgerStatus } from "@/domain/ledger";
import { formatUnits } from "@/domain/sweep-receipt";
import { LiveBadge, probeState } from "@/components/live-badge";
import { StatCard } from "@/components/stat-card";
import { ErrorNote, PendingNote } from "@/components/primitives";
import { shortAddress, shortHash, plural } from "@/components/short-value";
import { useApi } from "@/components/use-api";

const STATUS_STYLE: Record<LedgerStatus, string> = {
  complete: "border-lime-dim/60 bg-lime/5 text-lime",
  "reactive-only": "border-amber-900/60 bg-amber-950/20 text-amber-500",
  "orphan-sweep": "border-sky-900/70 bg-sky-950/20 text-sky-300",
};

const STATUS_NOTE: Record<LedgerStatus, string> = {
  complete:
    "A deposit and a sweep both exist and the sweep names the same burner/token. The reactive leg is the PurgeTriggered event or the decoded callback payload.",
  "reactive-only":
    "A deposit exists but no sweep does. The loop stalled: the route may be disarmed on one side, the burner allowance may be zero, or the destination budget may be exhausted.",
  "orphan-sweep":
    "A sweep exists but its deposit is outside the scanned window, or the deposit predates this deployment. It is retained because hiding it would make the ledger lie in the other direction.",
};

const LEDGER_STATUSES: readonly LedgerStatus[] = ["complete", "reactive-only", "orphan-sweep"];

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function amount(value: string | null, decimals: number, symbol: string): string {
  if (value === null) return "—";
  return `${formatUnits(value, decimals)} ${symbol}`;
}

function formatTimestamp(ts: number): string {
  if (ts <= 0) return "timestamp —";
  return `${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function LegCell({ leg, missing }: { leg: LedgerLegView | null; missing: string }) {
  if (leg === null) {
    return (
      <span className="font-mono text-[10px] text-slate-600" title={missing}>
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
        className="block font-mono text-[10.5px] text-slate-400 underline decoration-steel-bright underline-offset-2 hover:text-lime-glow"
        title={`${leg.txHash} · block ${leg.blockNumber}`}
      >
        {shortHash(leg.txHash)} ↗
        <span className="ml-1 text-slate-600">blk {leg.blockNumber}</span>
      </a>
      <span className="block font-mono text-[9.5px] text-slate-600">{formatTimestamp(leg.timestamp)}</span>
    </div>
  );
}

function LedgerRowView({ row, decimals, symbol }: { row: LedgerRow; decimals: number; symbol: string }) {
  return (
    <tr className="border-b border-steel/40 align-top hover:bg-steel/20">
      <td className="px-4 py-3">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[row.status]}`}>
          {row.status}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px]">
        <span className="block text-slate-300" title={row.burner}>
          {shortAddress(row.burner)}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.coldWallet ?? undefined}>
          {row.coldWallet ? shortAddress(row.coldWallet) : "cold wallet unobserved"}
        </span>
      </td>
      <td className="px-4 py-3">
        <LegCell leg={row.deposit} missing="no deposit" />
      </td>
      <td className="px-4 py-3">
        <LegCell leg={row.reactive} missing="no reactive proof" />
      </td>
      <td className="px-4 py-3">
        <LegCell leg={row.sweep} missing="awaiting sweep" />
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px]">
        <span className="block text-slate-300">{amount(row.depositAmount, decimals, symbol)}</span>
        <span className="mt-0.5 block text-slate-600">
          swept {row.sweptAmount === null ? "—" : amount(row.sweptAmount, decimals, symbol)}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">{formatLatency(row.latencyMs)}</td>
    </tr>
  );
}

export default function LedgerPage() {
  const ledger = useApi<LedgerIndex>("/api/ledger", 15_000);
  const { tokenDecimals, tokenSymbol } = readDeploymentConfig();
  const index = ledger.data;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Sweep Ledger</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            One row per observed deposit, joined across the three legs of the loop. A row is complete only when all
            three legs are real events; the two incomplete statuses are kept distinct.
          </p>
        </div>
        <LiveBadge
          state={probeState(index, ledger.error, ledger.loading)}
          detail={
            ledger.error ??
            (index ? plural(index.rows.length, "row") : "scanning event history…")
          }
        />
      </header>

      {(ledger.error ?? index?.error) && <ErrorNote>{ledger.error ?? index?.error}</ErrorNote>}

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="complete"
          value={index?.counts.complete.toString() ?? "—"}
          detail="deposit → reactive → sweep"
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
      </section>

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steel/70 px-4 py-3">
          <p className="label-caps">Ledger</p>
          {index && (
            <p className="font-mono text-[10px] text-slate-600">
              base {index.window.baseFrom ?? "?"}–{index.window.baseTo ?? "?"} · reactive{" "}
              {index.window.reactiveFrom ?? "?"}–{index.window.reactiveTo ?? "?"}
            </p>
          )}
        </div>

        {index === null ? (
          <PendingNote>Scanning event history…</PendingNote>
        ) : !index.configured ? (
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            {index.error ?? "Deployment addresses are not configured."}
          </p>
        ) : index.rows.length === 0 ? (
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            No deposits or sweeps in the scanned window. That is an observation, not an invented row.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[72rem] text-left">
              <thead className="border-b border-steel/60 font-mono text-[10px] uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-normal">status</th>
                  <th className="px-4 py-2 font-normal">burner / cold</th>
                  <th className="px-4 py-2 font-normal">deposit</th>
                  <th className="px-4 py-2 font-normal">reactive</th>
                  <th className="px-4 py-2 font-normal">sweep</th>
                  <th className="px-4 py-2 font-normal">amount</th>
                  <th className="px-4 py-2 font-normal">latency</th>
                </tr>
              </thead>
              <tbody>
                {index.rows.map((row) => (
                  <LedgerRowView
                    key={`${row.id}:${row.burner}`}
                    row={row}
                    decimals={tokenDecimals}
                    symbol={tokenSymbol}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel p-5">
        <p className="label-caps">How to read the statuses</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {LEDGER_STATUSES.map((status) => (
            <div key={status}>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[status]}`}>
                {status}
              </span>
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{STATUS_NOTE[status]}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
