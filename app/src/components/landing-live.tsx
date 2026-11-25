"use client";

import Link from "next/link";
import { VIEWS } from "@/config/views";
import { chainLabel } from "@/config/chains";
import { POLL_INTERVAL_MS } from "@/config/constants";
import type { ProofFileStatus, ProofRecord, ProofTransaction } from "@/domain/proof";
import { LiveBadge, probeState } from "./live-badge";
import { shortHash } from "./short-value";
import { useApi } from "./use-api";

interface RoutesSummary {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly sweepCount: string | null;
  readonly subscriptionCount: string | null;
  readonly counters: {
    readonly routes: number;
    readonly armed: number;
    readonly needsRepair: number;
    readonly revoked: number;
  };
}

export function LandingLive({
  proof,
  proofStatus,
  proofError,
}: {
  proof: ProofRecord | null;
  /** Why `proof` is null. Distinguishes "no run recorded" from "the record could not be read". */
  proofStatus: ProofFileStatus;
  proofError?: string;
}) {
  const routes = useApi<RoutesSummary>("/api/routes", POLL_INTERVAL_MS.routes);
  const data = routes.data;

  const badgeState = probeState(data, routes.error, routes.loading);

  const liveValue = (val: string | number | null | undefined): string => {
    if (!data || !data.configured || !data.verified || val === null || val === undefined) {
      return "—";
    }
    return String(val);
  };

  return (
    <>
      <section className="pb-16">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="label-caps">Five live views · read-only evidence</h2>
          <LiveBadge
            state={badgeState}
            detail={
              data === null
                ? routes.error ?? "probing /api/routes"
                : data.error ?? `${data.counters.armed} armed · ${data.counters.routes} total`
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {VIEWS.map((view) => (
            <Link
              key={view.id}
              href={view.href}
              className="panel group flex flex-col justify-between p-4 transition-colors hover:border-steel-bright"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-mono text-[13px] font-semibold text-slate-100 group-hover:text-lime-glow">
                    {view.label}
                  </h3>
                  <span className="font-mono text-xs text-slate-600 transition-transform group-hover:translate-x-0.5 group-hover:text-lime-glow">
                    →
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{view.description}</p>
              </div>
              <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-slate-600">{view.role}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="pb-20">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="label-caps">Live deployment counters &amp; latest proof</h2>
          <span className="font-mono text-[10.5px] text-slate-600">
            source: <code className="text-slate-400">/api/routes</code> &amp;{" "}
            <code className="text-slate-400">docs/proof/latest.json</code>
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <CounterBox label="Routes indexed" value={liveValue(data?.counters.routes)} />
          <CounterBox label="Routes armed" value={liveValue(data?.counters.armed)} tone="lime" />
          <CounterBox label="Needs repair" value={liveValue(data?.counters.needsRepair)} />
          <CounterBox label="RSC subscriptions" value={liveValue(data?.subscriptionCount)} />
          <CounterBox label="Forwarder sweeps" value={liveValue(data?.sweepCount)} tone="lime" />
        </div>

        <div className="panel mt-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="label-caps">Latest end-to-end proof</p>
            {proof ? (
              <span className="font-mono text-[11px] text-lime-glow">
                measured latency: {proof.latencyMs} ms ({(proof.latencyMs / 1000).toFixed(1)}s) ·{" "}
                {proof.generatedAt}
              </span>
            ) : proofStatus === "unreadable" ? (
              <span className="font-mono text-[11px] text-amber-500">record present, unreadable</span>
            ) : (
              <span className="font-mono text-[11px] text-slate-500">no run recorded yet</span>
            )}
          </div>

          {proof ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <ProofLegCard title="Arm / Register" tx={proof.transactions.arm} />
              <ProofLegCard title="Tx1 · Deposit" tx={proof.transactions.deposit} />
              {proof.transactions.callback && (
                <ProofLegCard title="Tx2 · Callback" tx={proof.transactions.callback} />
              )}
              <ProofLegCard title="Tx3 · Sweep" tx={proof.transactions.sweep} />
            </div>
          ) : proofStatus === "unreadable" ? (
            <>
              {/*
               * A file is there but this deployment could not read or parse it. That is a fault,
               * not an empty state, so it is reported as one instead of being softened into
               * "nothing to show yet". The visitor does not get told to run a shell script.
               */}
              <p className="mt-3 text-[13px] leading-relaxed text-amber-500">
                A recorded run exists on this deployment but could not be read. This is a
                deployment fault on our side, not an absence of evidence.
              </p>
              {proofError && (
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-amber-600">{proofError}</p>
              )}
            </>
          ) : (
            <p className="mt-3 text-[13px] leading-relaxed text-slate-400">
              This deployment has no recorded end-to-end run to show yet. The counters above are
              still read live from the chain on every page load, so an empty proof section here
              means only that no run has been recorded — never that a transaction is missing.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function CounterBox({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "lime";
}) {
  return (
    <div className="panel px-4 py-3">
      <p className="label-caps">{label}</p>
      <p className={`mt-1 font-mono text-2xl ${tone === "lime" ? "text-lime-glow" : "text-slate-100"}`}>
        {value}
      </p>
    </div>
  );
}

function ProofLegCard({ title, tx }: { title: string; tx: ProofTransaction }) {
  return (
    <div className="rounded border border-steel/70 bg-void/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold text-slate-200">{title}</span>
        <span className="font-mono text-[10px] text-slate-500">{chainLabel(tx.chainId)}</span>
      </div>
      <a
        href={tx.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block font-mono text-[11.5px] text-lime-glow underline decoration-lime-dim underline-offset-2 hover:decoration-lime"
        title={tx.hash}
      >
        {shortHash(tx.hash)} ↗
      </a>
      <p className="mt-1 font-mono text-[10px] text-slate-500">block {tx.blockNumber}</p>
    </div>
  );
}
