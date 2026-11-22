"use client";

import Link from "next/link";
import { useState } from "react";
import { VIEWS, type ViewId } from "@/config/views";
import type { RouteIndex, RouteIndexRow } from "@/infrastructure/route-indexer";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { BudgetResponse, RefusalResponse } from "@/domain/api-responses";
import { allCasesReverted, revertedCount } from "@/domain/refusal";
import type { RegistryStatus } from "@/domain/registry";
import { applyRouteRepair, type LifecycleAction } from "@/application/route-lifecycle";
import { createLifecycleWriter } from "@/infrastructure/lifecycle-writer";
import { LiveBadge, probeState, type ProbeState } from "@/components/live-badge";
import { FailureReport, PhasePill, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { ReadOnlyNote } from "@/components/wallet-button";
import { StatCard } from "@/components/stat-card";
import { ErrorNote, PendingNote } from "@/components/primitives";
import { RepairAction, type RepairKind } from "@/components/repair-action";
import { shortAddress, plural } from "@/components/short-value";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "./use-write";
import { useWallet } from "./wallet";

const STATUS_STYLE: Record<RegistryStatus, string> = {
  agree: "border-lime-dim/60 bg-lime/5 text-lime",
  "rsc-only": "border-amber-900/60 bg-amber-950/20 text-amber-500",
  "forwarder-only": "border-red-900/60 bg-red-950/20 text-red-400",
  drifted: "border-red-900/70 bg-red-950/25 text-red-300",
  revoked: "border-steel bg-steel/20 text-slate-500",
};

const DANGER_STATUSES: readonly RegistryStatus[] = ["drifted", "forwarder-only"];

function refusalProbe(data: RefusalResponse | null, error: string | null, loading: boolean): ProbeState {
  const base = probeState(data, error, loading);
  if (base !== "live" || data === null) return base;
  return allCasesReverted(data.cases) ? "live" : "degraded";
}

function describeRegistry(index: RouteIndex | null, error: string | null): string {
  if (index === null) return error ?? "probing…";
  if (!index.configured) return "unset";
  return `${index.counters.armed} armed · ${index.counters.routes} total`;
}

function describeArm(index: RouteIndex | null, error: string | null): string {
  if (index === null) return error ?? "probing…";
  if (!index.configured) return "unset";
  return index.rscForwarder ? `${index.counters.needsRepair} need repair` : "forwarder unset";
}

function describeLedger(data: LedgerIndex | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured) return "unset";
  return `${data.counts.complete} complete · ${data.counts.reactiveOnly} stalled`;
}

function describeBudget(data: BudgetResponse | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured || !data.budget) return "unset";
  return `${data.budget.sweepsRemaining} sweeps left`;
}

function describeRefusals(data: RefusalResponse | null, error: string | null): string {
  if (data === null) return error ?? "probing…";
  if (!data.configured) return "unset";
  return `${revertedCount(data.cases)}/${data.cases.length} reverted`;
}

export default function RegistryPage() {
  const routes = useApi<RouteIndex>("/api/routes", 12_000);
  const ledger = useApi<LedgerIndex>("/api/ledger", 20_000);
  const budget = useApi<BudgetResponse>("/api/budget", 20_000);
  const refusals = useApi<RefusalResponse>("/api/refusals", 30_000);
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

  const repairAuthority = (row: RouteIndexRow) =>
    row.diagnosis.status === "rsc-only"
      ? { isOwner: isRscOwner, owner: index?.rscOwner ?? null, ownerRole: "the RSC owner" }
      : { isOwner: isForwarderOwner, owner: index?.forwarderOwner ?? null, ownerRole: "the forwarder owner" };

  const anyError = routes.error ?? ledger.error ?? budget.error ?? refusals.error;

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

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} busy={busy !== null} />
      <FailureReport reason={gate.failure?.reason ?? null} decoded={gate.failure?.decoded} onClear={gate.clearFailure} />
      <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="routes" value={index?.counters.routes.toString() ?? "—"} />
        <StatCard label="armed" value={index?.counters.armed.toString() ?? "—"} />
        <StatCard label="needs repair" value={index?.counters.needsRepair.toString() ?? "—"} tone="warn" />
        <StatCard label="revoked" value={index?.counters.revoked.toString() ?? "—"} tone="muted" />
        <StatCard label="RSC subscriptions" value={index?.subscriptionCount ?? "—"} />
      </section>

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
          <div className="px-4 py-8">
            <p className="text-[12.5px] text-slate-500">No routes registered in the scanned window.</p>
            <Link href="/app/arm" className="mt-2 inline-block font-mono text-[11px] text-lime-glow hover:underline">
              arm the first route →
            </Link>
          </div>
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
                {index.rows.map((row) => {
                  const danger = DANGER_STATUSES.includes(row.diagnosis.status);
                  return (
                    <tr
                      key={`${row.token}:${row.burner}`}
                      className={`border-b border-steel/40 align-top ${danger ? "bg-red-950/10" : "hover:bg-steel/20"}`}
                    >
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className="block text-slate-200" title={row.burner}>
                          {shortAddress(row.burner)}
                        </span>
                        <span className="mt-0.5 block text-slate-600" title={row.token}>
                          {shortAddress(row.token)}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-slate-600">
                          tokensOf: {row.rscTokens.length}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className={row.rscActive ? "text-lime" : "text-slate-600"}>
                          {row.rscActive ? "active" : "inactive"}
                        </span>
                        <span className="mt-0.5 block text-slate-600" title={row.rscColdWallet ?? undefined}>
                          {shortAddress(row.rscColdWallet)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className={row.forwarderArmed ? "text-lime" : "text-slate-600"}>
                          {row.forwarderArmed ? "armed" : "unarmed"}
                        </span>
                        <span className="mt-0.5 block text-slate-600" title={row.forwarderColdWallet ?? undefined}>
                          {shortAddress(row.forwarderColdWallet)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">
                        {row.diagnosis.status === "drifted" ? (
                          <span className="text-red-300">mismatch</span>
                        ) : (
                          shortAddress(row.rscColdWallet ?? row.forwarderColdWallet)
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-600">
                        {row.lastEventBlock ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_STYLE[row.diagnosis.status]}`}
                        >
                          {row.diagnosis.status}
                        </span>
                        <p className="mt-1.5 max-w-xs text-[11px] leading-relaxed text-slate-500">
                          {row.diagnosis.summary}
                        </p>
                        {row.readError && (
                          <p className="mt-1 max-w-xs font-mono text-[10px] text-amber-500">{row.readError}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <RepairAction
                          status={row.diagnosis.status}
                          busy={repairBusy(row)}
                          walletConnected={wallet.connected}
                          isOwner={repairAuthority(row).isOwner}
                          owner={repairAuthority(row).owner}
                          ownerRole={repairAuthority(row).ownerRole}
                          onRevoke={() => void runRepair(row, "revoke-rsc")}
                          onDisarm={() => void runRepair(row, "disarm-forwarder")}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
