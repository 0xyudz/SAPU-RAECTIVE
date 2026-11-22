"use client";

import type { RefusalResponse } from "@/domain/api-responses";
import { REFUSAL_CASE_IDS, REFUSAL_OUTCOME_TONE, revertedCount } from "@/domain/refusal";
import { POLL_INTERVAL_MS } from "@/config/constants";
import { LiveBadge, refusalProbe } from "@/components/live-badge";
import { ErrorNote, StatusPill } from "@/components/primitives";
import { shortAddress } from "@/components/short-value";
import { useApi } from "@/components/use-api";

export default function RefusalsPage() {
  const refusals = useApi<RefusalResponse>("/api/refusals", POLL_INTERVAL_MS.refusals);
  const data = refusals.data;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Refusal Lab</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            {REFUSAL_CASE_IDS.length} calls that must fail, executed against the live contracts from the exact caller
            that should be rejected. Each card prints the raw revert data and the decoded error name. No transaction is
            sent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={refusals.refresh}
            disabled={refusals.loading}
            className="rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-300 transition-colors hover:border-lime-dim hover:text-lime-glow disabled:opacity-50"
          >
            {refusals.loading ? "probing…" : "Re-run probes"}
          </button>
          <LiveBadge
            state={refusalProbe(data, refusals.error, refusals.loading)}
            detail={
              refusals.error ??
              (data ? `${revertedCount(data.cases)}/${REFUSAL_CASE_IDS.length} reverted` : "waiting")
            }
          />
        </div>
      </header>

      {(refusals.error ?? data?.error) && <ErrorNote>{refusals.error ?? data?.error}</ErrorNote>}

      {data?.callers && (
        <section className="panel p-4">
          <p className="label-caps">Executed from</p>
          <dl className="mt-2 grid gap-1 font-mono text-[10.5px] sm:grid-cols-[10rem_1fr]">
            <dt className="text-slate-600">non-owner caller</dt>
            <dd className="break-all text-slate-300" title={data.callers.nonOwner}>
              {data.callers.nonOwner}
            </dd>
            <dt className="text-slate-600">callback proxy</dt>
            <dd className="break-all text-slate-300" title={data.callers.callbackProxy}>
              {data.callers.callbackProxy}
            </dd>
            {data.pairs && (
              <>
                <dt className="text-slate-600">disarmed pair</dt>
                <dd className="break-all text-slate-400">
                  {shortAddress(data.pairs.disarmed.burner)} → {shortAddress(data.pairs.disarmed.coldWallet)}
                </dd>
                <dt className="text-slate-600">zero-balance pair</dt>
                <dd className="break-all text-slate-400">
                  {shortAddress(data.pairs.zeroBalance.burner)} → {shortAddress(data.pairs.zeroBalance.coldWallet)}
                </dd>
              </>
            )}
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            The two pair-dependent cases use routes derived from the registry. The caller-authorization cases use an
            address that is not the owner of either contract.
          </p>
        </section>
      )}

      {data === null ? (
        <p className="font-mono text-[11.5px] text-slate-600">
          Executing {REFUSAL_CASE_IDS.length} eth_calls…
        </p>
      ) : data.cases.length === 0 ? (
        <p className="text-[12.5px] text-slate-500">{data.error ?? "No cases were executed."}</p>
      ) : (
        <section className="grid gap-3 lg:grid-cols-2">
          {data.cases.map((item) => (
            <article key={item.id} className="panel flex flex-col p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="font-mono text-[13px] font-semibold text-slate-100">{item.title}</h2>
                <StatusPill label={item.outcome} tone={REFUSAL_OUTCOME_TONE[item.outcome]} />
              </div>

              <p className="mt-2 font-mono text-[10.5px] text-slate-600">
                expected <span className="text-slate-400">{item.expectedError}</span>
              </p>

              <div className="mt-3 rounded border border-steel/60 bg-void/40 p-2.5">
                <p className="label-caps">call</p>
                <p className="mt-1 break-all font-mono text-[10.5px] text-slate-300">{item.call}</p>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-600" title={item.executedFrom}>
                  from {item.executedFrom}
                </p>
              </div>

              <div className="mt-3 rounded border border-steel/60 bg-void/40 p-2.5">
                <p className="label-caps">decoded</p>
                <p className="mt-1 font-mono text-[11px]">
                  {item.decodedName === null ? (
                    <span className="text-amber-500">no decoded error name</span>
                  ) : (
                    <span className="text-red-300">{item.decodedName}</span>
                  )}
                  {item.decodedArgs.length > 0 && (
                    <span className="ml-1 break-all text-slate-500">({item.decodedArgs.join(", ")})</span>
                  )}
                </p>
              </div>

              <div className="mt-3 rounded border border-steel/60 bg-void/40 p-2.5">
                <p className="label-caps">raw revert data</p>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-400">{item.raw}</p>
              </div>

              <p className="mt-3 flex-1 text-[11.5px] leading-relaxed text-slate-500">{item.explanation}</p>
              {item.detail && (
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-amber-500">{item.detail}</p>
              )}
            </article>
          ))}
        </section>
      )}

      <section className="panel p-5">
        <p className="label-caps">Why simulation, not a transaction</p>
        <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-slate-500">
          A refused write is supposed to cost nothing. Sending it would burn gas to prove a point the EVM already made
          during <code className="text-slate-400">eth_call</code>. The call is still executed by the live chain&apos;s
          EVM against live state, from the exact caller that should be rejected, so the revert bytes are real.
        </p>
      </section>
    </div>
  );
}
