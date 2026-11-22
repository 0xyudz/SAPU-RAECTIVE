"use client";

import type { DecodedCallError, TxReceipt, WritePhase } from "@/domain/tx-receipt";
import { chainLabel } from "@/config/chains";
import { shortHash } from "./short-value";

const PHASE_LABEL: Record<WritePhase, string> = {
  idle: "idle",
  simulating: "simulating…",
  signing: "waiting for signature…",
  pending: "pending…",
  confirmed: "confirmed",
  failed: "failed",
};

export function PhasePill({ phase }: { phase: WritePhase }) {
  const tone =
    phase === "confirmed"
      ? "border-lime-dim/60 bg-lime/5 text-lime"
      : phase === "failed"
        ? "border-red-900/60 bg-red-950/20 text-red-400"
        : phase === "idle"
          ? "border-steel text-slate-500"
          : "border-amber-900/60 bg-amber-950/20 text-amber-500";
  return (
    <span className={`rounded border px-2 py-1 font-mono text-[10px] tracking-wide ${tone}`}>
      {PHASE_LABEL[phase]}
    </span>
  );
}

export function ProofDrawer({
  receipts,
  onClear,
}: {
  receipts: readonly TxReceipt[];
  onClear?: () => void;
}) {
  if (receipts.length === 0) return null;

  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Transaction receipts</p>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] text-slate-600 transition-colors hover:text-slate-300"
          >
            clear
          </button>
        )}
      </div>

      <ul className="mt-4 space-y-2.5">
        {receipts.map((receipt) => (
          <li
            key={`${receipt.chainId}:${receipt.hash}`}
            className="rounded border border-steel/70 bg-void/40 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11.5px] text-slate-200">{receipt.label}</span>
              <span
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  receipt.status === "success"
                    ? "border-lime-dim/60 bg-lime/5 text-lime"
                    : "border-red-900/60 bg-red-950/20 text-red-400"
                }`}
              >
                {receipt.status}
              </span>
            </div>

            <dl className="mt-2 grid gap-x-4 gap-y-1 font-mono text-[10.5px] text-slate-500 sm:grid-cols-2">
              <div className="flex justify-between gap-2 sm:col-span-2">
                <dt>hash</dt>
                <dd>
                  <a
                    href={receipt.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-lime-glow underline decoration-lime-dim underline-offset-2 hover:decoration-lime"
                    title={receipt.hash}
                  >
                    {shortHash(receipt.hash)} ↗
                  </a>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>chain</dt>
                <dd>
                  {chainLabel(receipt.chainId)} · {receipt.chainId}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>block</dt>
                <dd>{receipt.blockNumber.toString()}</dd>
              </div>
              <div className="flex justify-between gap-2 sm:col-span-2">
                <dt>gas used</dt>
                <dd>{receipt.gasUsed.toString()}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FailureReport({
  reason,
  decoded,
  onClear,
}: {
  reason: string | null;
  decoded?: DecodedCallError;
  onClear?: () => void;
}) {
  if (reason === null) return null;

  return (
    <section className="rounded-lg border border-red-900/60 bg-red-950/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] tracking-wider text-red-400">TRANSACTION FAILED</p>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] text-slate-500 transition-colors hover:text-slate-300"
          >
            dismiss
          </button>
        )}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-slate-300">{reason}</p>
      {decoded && (
        <dl className="mt-3 space-y-1 font-mono text-[10.5px] text-slate-500">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">error</dt>
            <dd className="text-red-300">{decoded.name}</dd>
          </div>
          {decoded.args && decoded.args.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0">args</dt>
              <dd className="break-all text-slate-400">{decoded.args.map(String).join(", ")}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">raw</dt>
            <dd className="break-all text-slate-400">{decoded.raw}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
