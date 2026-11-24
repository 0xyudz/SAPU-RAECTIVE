"use client";

import Link from "next/link";
import { useState } from "react";
import { VIEWS, type ViewId } from "@/config/views";
import { POLL_INTERVAL_MS } from "@/config/constants";
import type { RouteIndex, RouteIndexRow } from "@/infrastructure/route-indexer";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { BudgetResponse, RefusalResponse } from "@/domain/api-responses";
import { revertedCount } from "@/domain/refusal";
import { applyRouteRepair, type LifecycleAction } from "@/application/route-lifecycle";
import { createLifecycleWriter } from "@/infrastructure/lifecycle-writer";
import { LiveBadge, probeState, refusalProbe, type ProbeState } from "@/components/live-badge";
import { FailureReport, PhasePill, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { ReadOnlyNote } from "@/components/wallet-button";
import { StatCard } from "@/components/stat-card";
import { ErrorNote, PendingNote } from "@/components/primitives";
import type { RepairKind } from "@/components/repair-action";
import { plural } from "@/components/short-value";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "./use-write";
import { useWallet } from "./wallet";
import { RegistryRow, EmptyInventory, type RepairAuthority } from "./registry-row";

function describeRegistry(index: RouteIndex | null, error: string | null): string {
  if (index === null) return error ?? "probing…";
  if (!index.configured) return "unset";
  // An unverified index never read the chain, so its zeroed counters are not facts.
  if (!index.verified) return "unverified — no chain read";
  return `${index.counters.armed} armed · ${index.counters.routes} total`;
}

function describeArm(index: RouteIndex | null, error: string | null): string {
  if (index === null) return error ?? "probing…";
  if (!index.configured) return "unset";
  // `rscForwarder` is null both when SapuRSC has no forwarder set and when the read failed.
  // Those are opposite facts, so the read failure is reported as such instead of as "unset".
  if (index.rscForwarder === null) return "forwarder unreadable";
  return `${index.counters.needsRepair} need repair`;
}

function describeLedger(data: LedgerIndex | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured) return "unset";
  // A scan that could not reach a chain head (or lost a log query) has no window to count over.
  // `verified` is false in exactly that case, and its zeroed counts are the absence of a scan,
  // not the absence of activity.
  if (!data.verified) return "scan incomplete";
  return `${data.counts.complete} complete · ${data.counts.reactiveOnly} stalled`;
}

function describeBudget(data: BudgetResponse | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured || !data.budget) return "unset";
  // `sweepsRemaining` is null when the cost per sweep could not be computed. Printing "null
  // sweeps left" or "0 sweeps left" would both be claims the reading does not support.
  return data.budget.sweepsRemaining === null
    ? "runway unknown"
    : `${data.budget.sweepsRemaining} sweeps left`;
}

function describeRefusals(data: RefusalResponse | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured) return "unset";
  return `${revertedCount(data.cases)}/${data.cases.length} reverted`;
}

export default function RegistryPage() {
  const routes = useApi<RouteIndex>("/api/routes", POLL_INTERVAL_MS.routes);
  const ledger = useApi<LedgerIndex>("/api/ledger", POLL_INTERVAL_MS.ledger);
  const budget = useApi<BudgetResponse>("/api/budget", POLL_INTERVAL_MS.budget);
  const refusals = useApi<RefusalResponse>("/api/refusals", POLL_INTERVAL_MS.refusals);
  const { wallet } = useWallet();
  const gate = useWriteGate();
  const [busy, setBusy] = useState<string | null>(null);

  const index = routes.data;

  const probes: Record<ViewId, ProbeState> = {
    registry: probeState(index, routes.error, routes.loading),
    arm: probeState(index, routes.error, routes.loading),
    ledger: probeState(ledger.data, ledger.error, ledger.loading),
    budget: probeState(budget.data, budget.error, budget.loading),
    refusals: refusalProbe(refusals.data, refusals.error, refusals.loading),
  };

  const probeDetails: Record<ViewId, string> = {
    registry: describeRegistry(index, routes.error),
    arm: describeArm(index, routes.error),
    ledger: describeLedger(ledger.data, ledger.error),
    budget: describeBudget(budget.data, budget.error),
    refusals: describeRefusals(refusals.data, refusals.error),
  };

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isRscOwner = walletAddress !== null && walletAddress === index?.rscOwner;
  const isForwarderOwner = walletAddress !== null && walletAddress === index?.forwarderOwner;

  const runRepair = async (row: RouteIndexRow, action: LifecycleAction) => {
    if (!index?.rsc || !index.forwarder) return;
    gate.reset();
    setBusy(`${row.burner}:${action}`);
    try {
      await applyRouteRepair(
        createLifecycleWriter(),
        {
          rsc: index.rsc,
          forwarder: index.forwarder,
          burner: row.burner,
          token: row.token,
          action,
        },
        gate.options,
      );
    } finally {
      setBusy(null);
    }
    routes.refresh();
  };

  const repairBusy = (row: RouteIndexRow): RepairKind | null => {
    if (busy === `${row.burner}:revoke-rsc`) return "revoke-rsc";
    if (busy === `${row.burner}:disarm-forwarder`) return "disarm-forwarder";
    return null;
  };

  const authorityFor = (row: RouteIndexRow): RepairAuthority =>
    row.diagnosis.repair === "disarm-forwarder"
      ? { isOwner: isForwarderOwner, owner: index?.forwarderOwner ?? null, ownerRole: "the forwarder owner" }
      : { isOwner: isRscOwner, owner: index?.rscOwner ?? null, ownerRole: "the RSC owner" };

  const anyError = routes.error ?? ledger.error ?? budget.error ?? refusals.error;

  /**
   * Counters are only shown for an index that actually read the chain.
   *
   * `/api/routes` returns a full `counters` object with zeros even when it is unconfigured or
   * the `eth_getCode` verification failed, because the shape is fixed. Rendering those zeros
   * claims "0 routes, 0 armed, 0 need repair" — four facts — for a deployment that was never
   * read. The unreadable rows are excluded from the buckets too, so the counts describe the
   * readable subset; `unreadable` makes that explicit.
   */
  const counters = index !== null && index.configured && index.verified ? index.counters : null;
  const unreadable = counters !== null && counters.unreadable > 0 ? counters.unreadable : null;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Route Registry</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            Every route this deployment knows about. Each row is confirmed by reading both contracts after the event
            scan, so a stale log cannot make a broken route look armed.
          </p>
        </div>
        <LiveBadge
          state={probes.registry}
          detail={
            index === null
              ? (routes.error ?? "waiting for /api/routes")
              : (index.error ?? plural(index.rows.length, "route"))
          }
        />
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {VIEWS.map((view) => (
          <Link
            key={view.id}
            href={view.href}
            className="panel group flex min-h-[10.5rem] flex-col justify-between p-4 transition-colors hover:border-steel-bright"
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-mono text-[13px] font-semibold text-slate-100 group-hover:text-lime-glow">
                  {view.label}
                </h2>
                <LiveBadge state={probes[view.id]} detail={probeDetails[view.id]} />
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">{view.description}</p>
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-slate-600">{view.role}</p>
          </Link>
        ))}
      </section>

      {anyError && <ErrorNote>{anyError}</ErrorNote>}

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} />
      <FailureReport
        reason={gate.failure?.reason ?? null}
        decoded={gate.failure?.decoded}
        onClear={gate.clearFailure}
      />
      <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {/*
          Counters come from the same payload the table does, and they are only chain facts when
          the index actually read the chain. An unconfigured or unverified deployment reports
          `counters: { routes: 0, armed: 0, … }` — four confident zeros for a registry nobody
          looked at. Gating on `configured && verified` renders "—" instead, which is the honest
          answer for "no reading was taken".
        */}
        <StatCard label="routes" value={counters?.routes.toString() ?? "—"} />
        <StatCard label="armed" value={counters?.armed.toString() ?? "—"} tone="ok" />
        <StatCard label="needs repair" value={counters?.needsRepair.toString() ?? "—"} tone="warn" />
        <StatCard label="revoked" value={counters?.revoked.toString() ?? "—"} tone="muted" />
        <StatCard label="RSC subscriptions" value={index?.subscriptionCount ?? "—"} />
      </section>

      {unreadable !== null && (
        <p className="font-mono text-[10.5px] leading-relaxed text-amber-500">
          {unreadable} pair(s) could not be read on chain. They are counted in neither &ldquo;armed&rdquo; nor
          &ldquo;needs repair&rdquo;, because a failed read is not a verdict — reload once the node answers.
        </p>
      )}

      {index?.configured && index.verified && !isForwarderOwner && !isRscOwner && (
        <ReadOnlyNote>
          {wallet.connected ? "owner only — repairs are disabled for this wallet" : "connect wallet to sign owner actions"}
        </ReadOnlyNote>
      )}

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steel/70 px-4 py-3">
          <p className="label-caps">Inventory</p>
          {gate.phase !== "idle" && <PhasePill phase={gate.phase} />}
        </div>

        {index === null ? (
          <PendingNote>Reading both contracts…</PendingNote>
        ) : !index.configured ? (
          <p className="px-4 py-8 text-[12.5px] leading-relaxed text-slate-500">
            {index.error ?? "Deployment addresses are not configured."}
          </p>
        ) : index.rows.length === 0 ? (
          <EmptyInventory />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left">
              <thead className="border-b border-steel/60 font-mono text-[10px] uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-normal">burner / token</th>
                  <th className="px-4 py-2 font-normal">RSC</th>
                  <th className="px-4 py-2 font-normal">forwarder</th>
                  <th className="px-4 py-2 font-normal">cold wallets</th>
                  <th className="px-4 py-2 font-normal">last event</th>
                  <th className="px-4 py-2 font-normal">status</th>
                  <th className="px-4 py-2 font-normal">repair</th>
                </tr>
              </thead>
              <tbody>
                {index.rows.map((row) => (
                  <RegistryRow
                    key={`${row.token}:${row.burner}`}
                    row={row}
                    busy={repairBusy(row)}
                    walletConnected={wallet.connected}
                    authority={authorityFor(row)}
                    onRevoke={() => void runRepair(row, "revoke-rsc")}
                    onDisarm={() => void runRepair(row, "disarm-forwarder")}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
