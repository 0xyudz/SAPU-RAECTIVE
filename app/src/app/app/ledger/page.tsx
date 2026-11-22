"use client";


import { readDeploymentConfig } from "@/config/chains";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { LedgerLegView, LedgerRow, LedgerStatus } from "@/domain/ledger";
import { formatUnits } from "@/domain/sweep-receipt";
import { LiveBadge } from "@/components/live-badge";
import { useApi } from "@/components/use-api";

const STATUS_STYLE: Record<LedgerStatus, string> = {
  complete: "border-lime-dim/60 bg-lime/5 text-lime",
  "reactive-only": "border-amber-900/60 bg-amber-950/20 text-amber-500",
  "orphan-sweep": "border-sky-900/70 bg-sky-950/20 text-sky-300",
};

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

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
        {short(leg.txHash)} ↗
        <span className="ml-1 text-slate-600">blk {leg.blockNumber}</span>
      </a>
      <span className="block font-mono text-[9.5px] text-slate-600">{formatTimestamp(leg.timestamp)}</span>
    </div>
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
          state={
            index === null
              ? ledger.loading && ledger.error === null
                ? "loading"
                : "offline"
              : !index.configured
                ? "unconfigured"
                : index.verified
                  ? "live"
                  : "degraded"
          }
          detail={ledger.error ?? (index ? `${index.rows.length} row${index.rows.length === 1 ? "" : "s"}` : "scanning event history…")}
        />
      </header>

      {(ledger.error ?? index?.error) && (
        <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-500">
          {ledger.error ?? index?.error}
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <CountCard
          label="complete"
          value={index?.counts.complete ?? null}
          detail="deposit → reactive → sweep"
          className="border-lime-dim/40"
        />
        <CountCard
          label="reactive-only"
          value={index?.counts.reactiveOnly ?? null}
          detail="deposit seen, no sweep followed"
          className="border-amber-900/50"
        />
        <CountCard
          label="orphan-sweep"
          value={index?.counts.orphanSweep ?? null}
          detail="sweep with no deposit in window"
          className="border-sky-900/60"
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
          <p className="px-4 py-8 font-mono text-[11.5px] text-slate-600">Scanning event history…</p>
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
          <Explanation
            status="complete"
            body="A deposit and a sweep both exist and the sweep names the same burner/token. The reactive leg is the PurgeTriggered event or the decoded callback payload."
          />
          <Explanation
            status="reactive-only"
            body="A deposit exists but no sweep does. The loop stalled: the route may be disarmed on one side, the burner allowance may be zero, or the destination budget may be exhausted."
          />
          <Explanation
            status="orphan-sweep"
            body="A sweep exists but its deposit is outside the scanned window, or the deposit predates this deployment. It is retained because hiding it would make the ledger lie in the other direction."
          />
        </div>
      </section>
    </div>
  );
}

function CountCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: number | null;
  detail: string;
  className: string;
}) {
  return (
    <div className={`panel border px-4 py-3 ${className}`}>
      <p className="label-caps">{label}</p>
      <p className="mt-1 font-mono text-2xl text-slate-100">{value === null ? "—" : value}</p>
      <p className="mt-1 text-[10.5px] text-slate-600">{detail}</p>
    </div>
  );
}

function LedgerRowView({
  row,
  decimals,
  symbol,
}: {
  row: LedgerRow;
  decimals: number;
  symbol: string;
}) {
  return (
    <tr className="border-b border-steel/40 align-top hover:bg-steel/20">
      <td className="px-4 py-3">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[row.status]}`}>
          {row.status}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px]">
        <span className="block text-slate-300" title={row.burner}>
          {short(row.burner)}
        </span>
        <span className="mt-0.5 block text-slate-600" title={row.coldWallet ?? undefined}>
          {row.coldWallet ? short(row.coldWallet) : "cold wallet unobserved"}
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
      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">
        {formatLatency(row.latencyMs)}
      </td>
    </tr>
  );
}

function Explanation({ status, body }: { status: LedgerStatus; body: string }) {
  return (
    <div>
      <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[status]}`}>{status}</span>
      <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}
