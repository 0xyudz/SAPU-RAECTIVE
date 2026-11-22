import type { ReactNode } from "react";

export function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-slate-600">{label}</dt>
      <dd className="break-all text-right text-slate-300">{value}</dd>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-500">
      {children}
    </p>
  );
}

export function PendingNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 font-mono text-[11.5px] text-slate-600">{children}</p>;
}
