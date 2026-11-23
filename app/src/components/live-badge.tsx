import { allCasesReverted, type RefusalCaseResult } from "@/domain/refusal";

export type ProbeState = "live" | "degraded" | "offline" | "unconfigured" | "loading";

const STYLES: Record<ProbeState, { className: string; label: string }> = {
  live: { className: "border-lime-dim/60 bg-lime/5 text-lime", label: "LIVE" },
  degraded: { className: "border-amber-900/60 bg-amber-950/20 text-amber-500", label: "DEGRADED" },
  offline: { className: "border-red-900/60 bg-red-950/20 text-red-400", label: "NO DATA" },
  unconfigured: { className: "border-steel bg-steel/20 text-slate-500", label: "NOT CONFIGURED" },
  loading: { className: "border-steel bg-steel/20 text-slate-400", label: "LOADING" },
};

interface ProbeSubject {
  readonly configured: boolean;
  readonly verified: boolean;
}

export function probeState(
  value: ProbeSubject | null,
  error: string | null,
  loading: boolean,
): ProbeState {
  if (value === null) return loading && error === null ? "loading" : "offline";
  if (!value.configured) return "unconfigured";
  if (error !== null) return "degraded";
  return value.verified ? "live" : "degraded";
}

export function refusalProbe(
  value: (ProbeSubject & { readonly cases: readonly RefusalCaseResult[] }) | null,
  error: string | null,
  loading: boolean,
): ProbeState {
  const base = probeState(value, error, loading);
  if (base !== "live" || value === null) return base;
  return allCasesReverted(value.cases) ? "live" : "degraded";
}

export function LiveBadge({ state, detail }: { state: ProbeState; detail?: string }) {
  const style = STYLES[state];
  return (
    <span className="inline-flex items-center gap-1.5" title={detail}>
      <span
        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] tracking-wider ${style.className}`}
      >
        {state === "live" && <span className="pulse-dot" aria-hidden="true" />}
        {state === "loading" && <span className="pulse-dot" aria-hidden="true" />}
        {style.label}
      </span>
      {detail && <span className="font-mono text-[10px] text-slate-600">{detail}</span>}
    </span>
  );
}
