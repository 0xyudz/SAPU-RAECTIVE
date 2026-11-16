"use client";

/**
 * Live watcher terminal.
 *
 * Shows the loop as it happens, with a CometBFT consensus pulse driven by real block
 * heights — not a decorative animation. If the RPC stops responding, the pulse stops,
 * which is the honest signal.
 */

import { useState } from "react";
import type { SweepReceipt } from "@/domain/sweep-receipt";
import { currentStage, formatUnits, latencySeconds } from "@/domain/sweep-receipt";

export interface LiveWatcherProps {
  receipts: readonly SweepReceipt[];
  /** Base Sepolia head, or null when unreachable. */
  baseHead: bigint | null;
  /** Reactive Lasna head, or null when unreachable. */
  reactiveHead: bigint | null;
  /** True while the poller is active. */
  watching: boolean;
  /** Error surfaced from the last poll, if any. */
  error?: string | null;
  burnerAddress?: string | null;
}

export function LiveWatcher({ receipts, baseHead, reactiveHead, watching, error, burnerAddress }: LiveWatcherProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [trackedReceipts, setTrackedReceipts] = useState<readonly SweepReceipt[]>(receipts);

  // Append lines as receipts advance. This deliberately does *not* live in an
  // effect: the terminal is append-only, but an effect that calls setState on every
  // poll triggers a cascading render for data that is already present in props.
  // Adjusting state during render is React's documented pattern for exactly this
  // ("you might not need an effect"): it happens before commit, so there is no
  // intermediate paint and no second render pass driven by a dependency array.
  //
  // Append-only matters here because the server polls a sliding window. An old
  // deposit can fall out of the window while its line is still meaningful evidence,
  // so lines are never removed once shown. `seenKeys` is tracked separately from
  // `lines` so that the 200-line cap cannot cause an old transition to be re-appended.
  if (trackedReceipts !== receipts) {
    setTrackedReceipts(receipts);

    const nextSeen = new Set(seenKeys);
    const additions: LogLine[] = [];

    for (const receipt of receipts) {
      for (const [key, text, tone] of describeTransitions(receipt)) {
        if (nextSeen.has(key)) continue;
        nextSeen.add(key);
        additions.push({
          key,
          text,
          tone,
          at: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        });
      }
    }

    if (additions.length > 0) {
      setSeenKeys(nextSeen);
      setLines([...lines, ...additions].slice(-200));
    }
  }

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-steel px-4 py-2.5">
        <div className="flex items-center gap-2">
          {watching ? <span className="pulse-dot" /> : <span className="inline-block h-2 w-2 rounded-full bg-slate-700" />}
          <span className="font-mono text-[11px] text-slate-300">
            {watching ? "Watching Base Sepolia logs…" : "Watcher idle"}
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] text-slate-600">
          <span title="Base Sepolia head">
            base <span className="text-slate-400">{baseHead !== null ? baseHead.toString() : "—"}</span>
          </span>
          <span title="Reactive Lasna head">
            lasna <span className="text-slate-400">{reactiveHead !== null ? reactiveHead.toString() : "—"}</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-900/50 bg-red-950/20 px-4 py-2 font-mono text-[11px] text-red-400">
          rpc: {error}
        </div>
      )}

      <div className="max-h-72 overflow-y-auto bg-void/60 px-4 py-3 font-mono text-[11.5px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-slate-600">
            {burnerAddress
              ? `awaiting first deposit into ${burnerAddress.slice(0, 10)}…${burnerAddress.slice(-6)}`
              : "no burner selected — generate one to begin"}
            <span className="caret ml-1">&nbsp;</span>
          </p>
        ) : (
          lines.map((line) => (
            <div key={line.key} className="flex gap-2.5">
              <span className="shrink-0 text-slate-700">{line.at}</span>
              <span className={toneClass(line.tone)}>{line.text}</span>
            </div>
          ))
        )}
        {lines.length > 0 && (
          <p className="mt-1 text-slate-700">
            <span className="caret">&nbsp;</span>
          </p>
        )}
      </div>

      {receipts.length > 0 && <ProofTable receipts={receipts} />}
    </div>
  );
}

type Tone = "deposit" | "reactive" | "sweep" | "info";

interface LogLine {
  key: string;
  text: string;
  tone: Tone;
  at: string;
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case "deposit":
      return "text-slate-300";
    case "reactive":
      return "text-amber-400";
    case "sweep":
      return "text-lime-glow";
    default:
      return "text-slate-500";
  }
}

/** Produces one log line per leg a receipt has reached. */
function describeTransitions(receipt: SweepReceipt): Array<[string, string, Tone]> {
  const out: Array<[string, string, Tone]> = [];
  const short = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

  out.push([
    `${receipt.id}:deposit`,
    `tx1 deposit  ${formatUnits(receipt.depositAmount, receipt.tokenDecimals)} ${receipt.tokenSymbol} → burner  [${short(receipt.id)}]`,
    "deposit",
  ]);

  if (receipt.reactive) {
    out.push([
      `${receipt.id}:reactive`,
      `tx2 reactive callback requested by ${short(receipt.reactive.txHash)} on lasna`,
      "reactive",
    ]);
  }

  if (receipt.sweep && receipt.sweptAmount !== null) {
    const latency = latencySeconds(receipt);
    out.push([
      `${receipt.id}:sweep`,
      `tx3 sweep    ${formatUnits(receipt.sweptAmount, receipt.tokenDecimals)} ${receipt.tokenSymbol} → cold  [${short(receipt.sweep.txHash)}]${latency !== null ? `  (${latency}s)` : ""}`,
      "sweep",
    ]);
  }

  return out;
}

/** The verified proof table: Tx1 → Tx2 → Tx3, each linked to its explorer. */
export function ProofTable({ receipts }: { receipts: readonly SweepReceipt[] }) {
  return (
    <div className="border-t border-steel">
      <div className="flex items-center justify-between px-4 py-2">
        <p className="label-caps">Verified loop</p>
        <span className="font-mono text-[10px] text-slate-600">{receipts.length} deposit(s)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left font-mono text-[11px]">
          <thead>
            <tr className="border-y border-steel/70 text-[9.5px] uppercase tracking-widest text-slate-600">
              <th className="px-4 py-1.5 font-normal">Tx1 deposit</th>
              <th className="px-4 py-1.5 font-normal">Tx2 reactive</th>
              <th className="px-4 py-1.5 font-normal">Tx3 sweep</th>
              <th className="px-4 py-1.5 text-right font-normal">Latency</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => {
              const stage = currentStage(receipt);
              const latency = latencySeconds(receipt);
              return (
                <tr key={receipt.id} className="border-b border-steel/40 last:border-0">
                  <Cell leg={receipt.deposit} tone="text-slate-300" />
                  <Cell leg={receipt.reactive} tone="text-amber-400" pendingLabel={stage === "deposit" ? "waiting" : "…"} />
                  <Cell leg={receipt.sweep} tone="text-lime-glow" pendingLabel={stage === "sweep" ? "—" : "waiting"} />
                  <td className="px-4 py-1.5 text-right text-slate-500">
                    {latency !== null ? `${latency}s` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({
  leg,
  tone,
  pendingLabel,
}: {
  leg: SweepReceipt["deposit"] | null;
  tone: string;
  pendingLabel?: string;
}) {
  if (!leg) {
    return <td className="px-4 py-1.5 text-slate-700">{pendingLabel ?? "—"}</td>;
  }
  return (
    <td className="px-4 py-1.5">
      <a
        href={leg.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className={`${tone} underline decoration-steel-bright underline-offset-2 transition-colors hover:decoration-current`}
        title={`${leg.txHash} · block ${leg.blockNumber}`}
      >
        {leg.txHash.slice(0, 8)}…{leg.txHash.slice(-6)}
      </a>
    </td>
  );
}
