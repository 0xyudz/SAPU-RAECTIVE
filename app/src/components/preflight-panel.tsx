"use client";

import type { PreflightDiff } from "@/domain/tx-receipt";

/**
 * The approval gate for every write use case.
 *
 * There is deliberately no `busy` prop. A `disabled={busy}` fed by the page's operation flag
 * deadlocks every write flow: the page sets that flag *before* calling the use case, and the use
 * case blocks on `confirm()` — the very promise this panel's button resolves. By the time the
 * panel renders, `busy` is already true, so **Approve is permanently disabled** and arming,
 * rescuing, revoking and every budget action can only ever be cancelled.
 *
 * The flag is also unnecessary. `approve()` clears the diff synchronously, so the panel unmounts
 * on the first click and a second click finds no resolver and resolves nothing. The button cannot
 * be double-fired, which is the only thing `busy` was guarding against.
 */
export function PreflightPanel({
  diff,
  onApprove,
  onReject,
}: {
  diff: PreflightDiff | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  if (diff === null) return null;

  return (
    <section className="rounded-lg border border-amber-900/60 bg-amber-950/10 p-4" role="dialog" aria-modal="false">
      <p className="font-mono text-[11px] tracking-wider text-amber-400">PRE-FLIGHT · NOTHING SENT YET</p>
      <p className="mt-1 font-mono text-[11px] text-slate-400">{diff.label}</p>

      <table className="mt-3 w-full font-mono text-[10.5px]">
        <thead>
          <tr className="text-left text-slate-600">
            <th className="pb-1 font-normal">field</th>
            <th className="pb-1 font-normal">before</th>
            <th className="pb-1 font-normal">after</th>
          </tr>
        </thead>
        <tbody>
          {diff.changes.map((change) => (
            <tr key={change.label} className="border-t border-steel/50 align-top">
              <td className="py-1.5 pr-3 text-slate-400">{change.label}</td>
              <td className="py-1.5 pr-3 break-all text-slate-500">{change.before}</td>
              <td className="py-1.5 break-all text-lime-glow">{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="rounded-md bg-lime px-4 py-2 font-mono text-[12px] font-semibold text-void transition-colors hover:bg-lime-glow disabled:cursor-not-allowed disabled:opacity-50"
        >
          Approve &amp; sign
        </button>
        <button
          type="button"
          onClick={onReject}
          className="rounded-md border border-steel px-4 py-2 font-mono text-[12px] text-slate-400 transition-colors hover:border-steel-bright hover:text-slate-100"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
