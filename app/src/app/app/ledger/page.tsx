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
import { useWallet } from "../wallet";
import { useWriteGate } from "../use-write";

/** What `/api/ledger` adds on top of the index: who can rescue, and whether they can. */
interface LedgerResponse extends LedgerIndex {
  readonly forwarderOwner: Address | null;
  readonly capabilities: ForwarderCapabilities;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
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

function LedgerRowView({
  row,
  decimals,
  symbol,
  reactiveScanFailed,
  originScanFailed,
  rescue,
}: {
  row: LedgerRow;
  decimals: number | null;
  symbol: string;
  reactiveScanFailed: boolean;
  originScanFailed: boolean;
  rescue: React.ReactNode;
}) {
  return (
    <tr className="border-b border-steel/40 align-top hover:bg-steel/20">
      <td className="px-4 py-3">
        <StatusPill label={row.status} tone={LEDGER_STATUS_TONE[row.status]} />
      </td>
      <td className="px-4 py-3 font-mono text-[10.5px]">
        <span className="block text-slate-300" title={row.token}>
          {symbol}
        </span>
        <span className="mt-0.5 block text-[9.5px] text-slate-600" title={row.token}>
          {shortAddress(row.token)}
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
      <td className="px-4 py-3 font-mono text-[10.5px]">
        <span className="block text-slate-300">
          {formatAmount(row.depositAmount, decimals, symbol)}
        </span>
        <span className="mt-0.5 block text-slate-600">
          swept {formatAmount(row.sweptAmount, decimals, symbol)}
        </span>
      </td>
      <td className="px-4 py-3">
        <ResidueCell residue={row.residue} decimals={decimals} symbol={symbol} />
      </td>
      <td className="px-4 py-3">
        <AllowanceCell assessment={row.allowance} symbol={symbol} />
      </td>
      <td className="px-4 py-3">
        <StrandCauseCell cause={row.cause} />
      </td>
      <td className="px-4 py-3">{rescue}</td>
      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">{formatLatency(row.latencyMs)}</td>
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
          // Four absence claims used to be made here at once ("no deposits or sweeps in the
          // scanned window"), including for a scan that never reached a head. An empty result is
          // only evidence of absence when the window was actually covered.
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            {index.coverage.reactiveEvents && index.coverage.originEvents
              ? "No deposits or sweeps in the scanned window. That is an observation, not an invented row."
              : `The scan did not cover every leg, so this empty table is not evidence that nothing happened. ${
                  index.error ?? ""
                }`.trim()}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[72rem] text-left">
              <thead className="border-b border-steel/60 font-mono text-[10px] uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-normal">status</th>
                  <th className="px-4 py-2 font-normal">token</th>
                  <th className="px-4 py-2 font-normal">burner / cold</th>
                  <th className="px-4 py-2 font-normal">deposit</th>
                  <th className="px-4 py-2 font-normal">reactive</th>
                  <th className="px-4 py-2 font-normal">sweep</th>
                  <th className="px-4 py-2 font-normal">amount</th>
                  <th className="px-4 py-2 font-normal">in burner now</th>
                  <th className="px-4 py-2 font-normal">allowance</th>
                  <th className="px-4 py-2 font-normal">why stranded</th>
                  <th className="px-4 py-2 font-normal">recover</th>
                  <th className="px-4 py-2 font-normal">latency</th>
                </tr>
              </thead>
              <tbody>
                {index.rows.map((row) => (
                  <LedgerRowView
                    key={`${row.id}:${row.token}:${row.burner}`}
                    row={row}
                    decimals={decimalsFor(row.token)}
                    symbol={symbolFor(row.token)}
                    reactiveScanFailed={reactiveScanFailed}
                    originScanFailed={originScanFailed}
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

      <section className="panel p-5">
        <p className="label-caps">How to read the allowance</p>
        <AllowanceLegend />
      </section>

      <section className="panel p-5">
        <p className="label-caps">How to read the cause</p>
        <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
          The checks run in the order a sweep would hit them, so the reported cause is the first
          thing that would actually stop the next sweep. Hover a cell for the full explanation.
        </p>
        <StrandCauseLegend />
      </section>
    </div>
  );
}
