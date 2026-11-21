"use client";

import { useSyncExternalStore } from "react";

export interface BurnerView {
  readonly address: `0x${string}`;
  readonly label: string;
}

export interface BurnerGeneratorProps {
  readonly burners: readonly BurnerView[];
  readonly selected: string | null;
  readonly keyCount: number;
  readonly onCreate: () => void;
  readonly onSelect: (address: `0x${string}`) => void;
  readonly onForget: (address: `0x${string}`) => void;
  readonly onPurge: () => void;
  readonly mounted: boolean;
}

const subscribeNoop = () => () => {};

export function useBurnerMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

export function BurnerGenerator({
  burners,
  selected,
  keyCount,
  onCreate,
  onSelect,
  onForget,
  onPurge,
  mounted,
}: BurnerGeneratorProps) {
  if (!mounted) {
    return (
      <div className="panel p-5">
        <p className="label-caps">Burner</p>
        <p className="mt-3 font-mono text-xs text-slate-600">Initialising browser key vault…</p>
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Burner keys</p>
        <span className="font-mono text-[10px] text-slate-600">
          {keyCount} in memory · never persisted
        </span>
      </div>

      <button
        type="button"
        onClick={onCreate}
        className="mt-4 w-full rounded-md bg-lime px-4 py-2.5 font-mono text-sm font-semibold text-void transition-colors hover:bg-lime-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-lime-glow focus-visible:ring-offset-2 focus-visible:ring-offset-void"
      >
        + Generate burner
      </button>

      {burners.length === 0 ? (
        <p className="mt-4 text-[12.5px] leading-relaxed text-slate-500">
          No burners yet. Generation uses <code className="text-slate-400">crypto.getRandomValues</code> and the key
          stays in this tab only.
        </p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {burners.map((burner) => {
            const isSelected = selected === burner.address;
            return (
              <li key={burner.address}>
                <div
                  className={`flex items-center gap-2 rounded border px-2.5 py-2 transition-colors ${
                    isSelected ? "border-lime-dim bg-lime/5" : "border-steel/70 hover:border-steel-bright"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(burner.address)}
                    className="min-w-0 flex-1 text-left focus:outline-none"
                    aria-pressed={isSelected}
                  >
                    <span className="block font-mono text-[11px] text-slate-500">{burner.label}</span>
                    <span className="block truncate font-mono text-[12px] text-slate-200">{burner.address}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onForget(burner.address)}
                    className="shrink-0 rounded px-1.5 py-1 font-mono text-[10px] text-slate-600 transition-colors hover:bg-steel hover:text-slate-300"
                    aria-label={`Forget ${burner.label}`}
                  >
                    forget
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {burners.length > 0 && (
        <button
          type="button"
          onClick={onPurge}
          className="mt-3 w-full rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-500 transition-colors hover:border-red-900/70 hover:text-red-400"
        >
          Purge all keys from memory
        </button>
      )}
    </div>
  );
}
