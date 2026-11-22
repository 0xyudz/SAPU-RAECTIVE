"use client";


import Link from "next/link";
import { useState, type ReactNode } from "react";
import { VIEWS, type ViewId } from "@/config/views";
import type { RouteIndex, RouteIndexRow } from "@/infrastructure/route-indexer";
import type { LedgerIndex } from "@/infrastructure/ledger-indexer";
import type { RefusalCaseResult } from "@/application/refusal-lab";
import { applyRouteRepair, type LifecycleAction } from "@/application/route-lifecycle";
import { createLifecycleWriter } from "@/infrastructure/lifecycle-writer";
import { LiveBadge, type ProbeState } from "@/components/live-badge";
import { FailureReport, PhasePill, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { ReadOnlyNote } from "@/components/wallet-button";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "./use-write";
import { useWallet } from "./wallet";

interface BudgetResponse {
  configured: boolean;
  verified: boolean;
  error?: string;
  budget?: { sweepsRemaining: string };
}

interface RefusalResponse {
  configured: boolean;
  verified: boolean;
  error?: string;
  cases: readonly RefusalCaseResult[];
}

const STATUS_STYLE: Record<RouteIndexRow["diagnosis"]["status"], string> = {
  agree: "border-lime-dim/60 bg-lime/5 text-lime",
  "rsc-only": "border-amber-900/60 bg-amber-950/20 text-amber-500",
  "forwarder-only": "border-red-900/60 bg-red-950/20 text-red-400",
  drifted: "border-red-900/70 bg-red-950/25 text-red-300",
  revoked: "border-steel bg-steel/20 text-slate-500",
};

function short(value: string | null): string {
  if (value === null) return "—";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function probeState(
  value: { configured: boolean; verified: boolean } | null,
  error: string | null,
  loading: boolean,
): ProbeState {
  if (value === null) {
    if (loading && error === null) return "loading";
    return "offline";
  }
  if (!value.configured) return "unconfigured";
  return value.verified ? "live" : "degraded";
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
  const refusalState: ProbeState =
    refusals.data === null
      ? refusals.loading && refusals.error === null
        ? "loading"
        : "offline"
      : !refusals.data.configured
        ? "unconfigured"
        : refusals.data.verified && refusals.data.cases.length === 4 && refusals.data.cases.every((item) => item.outcome === "reverted")
          ? "live"
          : "degraded";

  const probes: Record<ViewId, ProbeState> = {
    registry: probeState(index, routes.error, routes.loading),
    arm: probeState(index, routes.error, routes.loading),
    ledger: probeState(ledger.data, ledger.error, ledger.loading),
    budget: probeState(budget.data, budget.error, budget.loading),
    refusals: refusalState,
  };

  const revertedCount =
    refusals.data?.cases.filter((item) => item.outcome === "reverted").length ?? 0;

  const probeDetails: Record<ViewId, string> = {
    registry:
      index === null
        ? routes.error ?? "probing…"
        : !index.configured
          ? "unset"
          : `${index.counters.armed} armed · ${index.counters.routes} total`,
    arm:
      index === null
        ? routes.error ?? "probing…"
        : !index.configured
          ? "unset"
          : index.rscForwarder
            ? `${index.counters.needsRepair} need repair`
            : "forwarder unset",
    ledger:
      ledger.data === null
        ? ledger.error ?? "probing…"
        : !ledger.data.configured
          ? "unset"
          : `${ledger.data.counts.complete} complete · ${ledger.data.counts.reactiveOnly} stalled`,
    budget:
      budget.data === null
        ? budget.error ?? "probing…"
        : !budget.data.configured || !budget.data.budget
          ? "unset"
          : `${budget.data.budget.sweepsRemaining} sweeps left`,
    refusals:
      refusals.data === null
        ? refusals.error ?? "probing…"
        : !refusals.data.configured
          ? "unset"
          : `${revertedCount}/4 reverted`,
  };

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isRscOwner = walletAddress !== null && walletAddress === index?.rscOwner;
  const isForwarderOwner = walletAddress !== null && walletAddress === index?.forwarderOwner;

  const runRepair = async (row: RouteIndexRow, action: LifecycleAction) => {
    if (!index?.rsc || !index.forwarder) return;
    gate.reset();
    setBusy(`${row.burner}:${action}`);
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
    setBusy(null);
    routes.refresh();
  };

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
              ? routes.error ?? "waiting for /api/routes"
              : index.error ?? `${index.rows.length} route${index.rows.length === 1 ? "" : "s"}`
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

      {(routes.error ?? ledger.error ?? budget.error ?? refusals.error) && (
        <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-500">
          {routes.error ?? ledger.error ?? budget.error ?? refusals.error}
        </p>
      )}

      <PreflightPanel
        diff={gate.diff}
        onApprove={gate.approve}
        onReject={gate.reject}
        busy={busy !== null}
      />
      <FailureReport reason={gate.failure?.reason ?? null} decoded={gate.failure?.decoded} onClear={gate.clearFailure} />
      <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Counter label="routes" value={index?.counters.routes ?? null} />
        <Counter label="armed" value={index?.counters.armed ?? null} />
        <Counter label="needs repair" value={index?.counters.needsRepair ?? null} tone="warn" />
        <Counter label="revoked" value={index?.counters.revoked ?? null} tone="muted" />
        <Counter
          label="RSC subscriptions"
          value={index?.subscriptionCount !== null && index?.subscriptionCount !== undefined ? Number(index.subscriptionCount) : null}
        />
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
          <p className="px-4 py-8 font-mono text-[11.5px] text-slate-600">Reading both contracts…</p>
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
                  const danger = row.diagnosis.status === "drifted" || row.diagnosis.status === "forwarder-only";
                  return (
                    <tr
                      key={`${row.token}:${row.burner}`}
                      className={`border-b border-steel/40 align-top ${
                        danger ? "bg-red-950/10" : "hover:bg-steel/20"
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className="block text-slate-200" title={row.burner}>
                          {short(row.burner)}
                        </span>
                        <span className="mt-0.5 block text-slate-600" title={row.token}>
                          {short(row.token)}
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
                          {short(row.rscColdWallet)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className={row.forwarderArmed ? "text-lime" : "text-slate-600"}>
                          {row.forwarderArmed ? "armed" : "unarmed"}
                        </span>
                        <span className="mt-0.5 block text-slate-600" title={row.forwarderColdWallet ?? undefined}>
                          {short(row.forwarderColdWallet)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10.5px] text-slate-500">
                        {row.diagnosis.status === "drifted" ? (
                          <span className="text-red-300">mismatch</span>
                        ) : (
                          short(row.rscColdWallet ?? row.forwarderColdWallet)
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
                          row={row}
                          busyId={busy}
                          walletConnected={wallet.connected}
                          rscOwner={index.rscOwner}
                          forwarderOwner={index.forwarderOwner}
                          isRscOwner={isRscOwner}
                          isForwarderOwner={isForwarderOwner}
                          onRepair={runRepair}
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

function Counter({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | null;
  tone?: "default" | "warn" | "muted";
}) {
  const color = tone === "warn" ? "text-amber-500" : tone === "muted" ? "text-slate-500" : "text-slate-100";
  return (
    <div className="panel px-4 py-3">
      <p className="label-caps">{label}</p>
      <p className={`mt-1 font-mono text-2xl ${color}`}>{value === null ? "—" : value}</p>
    </div>
  );
}

function RepairAction({
  row,
  busyId,
  walletConnected,
  rscOwner,
  forwarderOwner,
  isRscOwner,
  isForwarderOwner,
  onRepair,
}: {
  row: RouteIndexRow;
  busyId: string | null;
  walletConnected: boolean;
  rscOwner: string | null;
  forwarderOwner: string | null;
  isRscOwner: boolean;
  isForwarderOwner: boolean;
  onRepair: (row: RouteIndexRow, action: LifecycleAction) => Promise<void>;
}) {
  const revokeBusy = busyId === `${row.burner}:revoke-rsc`;
  const disarmBusy = busyId === `${row.burner}:disarm-forwarder`;
  if (row.diagnosis.status === "revoked") {
    return <span className="font-mono text-[10px] text-slate-600">none</span>;
  }

  if (row.diagnosis.status === "agree") {
    return <span className="font-mono text-[10px] text-lime-dim">none</span>;
  }

  if (row.diagnosis.status === "rsc-only") {
    return (
      <div className="space-y-2">
        <Link href="/app/arm" className="block font-mono text-[10.5px] text-lime-glow hover:underline">
          arm forwarder →
        </Link>
        {gateHint(walletConnected, isRscOwner, rscOwner, "the RSC owner") ?? (
          <button
            type="button"
            disabled={revokeBusy}
            onClick={() => void onRepair(row, "revoke-rsc")}
            className="rounded border border-steel px-2 py-1 font-mono text-[10px] text-slate-400 transition-colors hover:border-red-900/70 hover:text-red-400 disabled:opacity-50"
          >
            {revokeBusy ? "working…" : "revoke RSC"}
          </button>
        )}
      </div>
    );
  }

  const hint = gateHint(walletConnected, isForwarderOwner, forwarderOwner, "the forwarder owner");
  if (hint) return hint;

  return (
    <button
      type="button"
      disabled={disarmBusy}
      onClick={() => void onRepair(row, "disarm-forwarder")}
      className="rounded border border-red-900/70 bg-red-950/20 px-2 py-1 font-mono text-[10px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-50"
    >
      {disarmBusy ? "working…" : "disarm forwarder"}
    </button>
  );
}

function gateHint(
  connected: boolean,
  isOwner: boolean,
  owner: string | null,
  role: string,
): ReactNode | null {
  if (!connected) {
    return <span className="font-mono text-[10px] text-slate-500">connect wallet</span>;
  }
  if (!isOwner) {
    return (
      <span className="font-mono text-[10px] text-slate-500" title={owner ?? undefined}>
        read-only · {role}
      </span>
    );
  }
  return null;
}
