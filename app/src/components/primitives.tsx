import type { ReactNode } from "react";
import type { Tone } from "@/domain/tone";
import { TONE_BADGE } from "./tone";

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

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${TONE_BADGE[tone]}`}>{label}</span>
  );
}

export const INPUT_CLASS =
  "mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none";

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  inputMode?: "numeric" | "text";
}) {
  return (
    <>
      <label className="label-caps mt-4 block" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        spellCheck={false}
        className={INPUT_CLASS}
      />
      {hint && <p className="mt-1 font-mono text-[10px] text-slate-600">{hint}</p>}
    </>
  );
}
