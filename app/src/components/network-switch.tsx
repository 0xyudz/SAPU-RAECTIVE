"use client";

import { networkScope, type NetworkSelection, type NetworkScope } from "@/domain/network-scope";

/**
 * Testnet / mainnet selector for the header.
 *
 * The switch never pretends to re-point the app. The build is wired to one deployment
 * (see `config/chains.ts`), so selecting the other network cannot produce that network's
 * data — it can only be honest about the absence. The component is presentational: the
 * selection lives in `AppShell` so the notice can render below the header rather than
 * inside the toolbar row.
 */
export function NetworkSwitch({
  selected,
  scope,
  onSelect,
  onToggleNotice,
  noticeOpen,
}: {
  selected: NetworkSelection;
  scope: NetworkScope;
  onSelect: (network: NetworkSelection) => void;
  onToggleNotice: () => void;
  noticeOpen: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Reactive network"
      className="inline-flex items-center overflow-hidden rounded border border-steel font-mono text-[10.5px]"
    >
      {(["testnet", "mainnet"] as const).map((network) => {
        const active = selected === network;
        return (
          <button
            key={network}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(network)}
            className={`px-2 py-1.5 transition-colors ${
              active
                ? network === "mainnet"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-lime/10 text-lime-glow"
                : "text-slate-500 hover:bg-steel/50 hover:text-slate-300"
            }`}
          >
            {network}
          </button>
        );
      })}
      {scope.state !== "live" && (
        <button
          type="button"
          onClick={onToggleNotice}
          aria-expanded={noticeOpen}
          className="border-l border-steel px-2 py-1.5 text-amber-400/90 hover:text-amber-300"
          title={`${scope.label} — see what is missing`}
        >
          {scope.label}
        </button>
      )}
    </div>
  );
}

/** Explains why the selected network is not readable, and what it would take. */
export function NetworkNotice({
  scope,
  liveOrigin,
  liveReactive,
  onClose,
}: {
  scope: NetworkScope;
  liveOrigin: string;
  liveReactive: string;
  onClose: () => void;
}) {
  return (
    <div className="border-t border-amber-900/50 bg-amber-950/10 px-5 py-4">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-[11px] text-amber-300">{scope.summary}</p>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-slate-400 hover:text-slate-200"
          >
            close
          </button>
        </div>

        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <section>
            <h3 className="label-caps">Current limitations</h3>
            <ul className="mt-2 space-y-1.5">
              {scope.limitations.map((item) => (
                <li
                  key={item}
                  className="flex gap-2 font-mono text-[10.5px] leading-relaxed text-slate-400"
                >
                  <span aria-hidden="true" className="text-amber-500/70">
                    ·
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="label-caps">To make it live</h3>
            <ol className="mt-2 space-y-1.5">
              {scope.prerequisites.map((item, index) => (
                <li
                  key={item}
                  className="flex gap-2 font-mono text-[10.5px] leading-relaxed text-slate-400"
                >
                  <span aria-hidden="true" className="text-slate-600">
                    {index + 1}.
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <p className="mt-3 border-t border-steel/50 pt-2 font-mono text-[10px] text-slate-600">
          The pages below still read {liveOrigin} + {liveReactive}. Selecting a network changes
          nothing on chain; it only changes this notice.
        </p>
      </div>
    </div>
  );
}

/** Convenience: the scope for a selection against the configured deployment. */
export function scopeFor(input: {
  configured: NetworkSelection;
  selected: NetworkSelection;
  liveOrigin: string;
  liveReactive: string;
}): NetworkScope {
  return networkScope(input);
}
