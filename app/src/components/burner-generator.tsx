"use client";

/**
 * Burner generator.
 *
 * Keys are generated in the browser and held only in module memory. This component
 * is the only place that creates them, and it never transmits them anywhere.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { createBurner, listBurners, forgetBurner, purgeAll, keyCount, type BurnerHandle } from "@/infrastructure/ephemeral-key-vault";

export interface BurnerGeneratorProps {
  onSelect?: (burner: BurnerHandle) => void;
  selected?: string | null;
}

const subscribeNoop = () => () => {};

export function BurnerGenerator({ onSelect, selected }: BurnerGeneratorProps) {
  // Hydration guard without an effect. The vault exists only in the browser, so the
  // server snapshot is `false` and the first client render is also `false` until
  // hydration completes — which is exactly what keeps the markup in sync. Using
  // `useEffect(() => setMounted(true))` would render the placeholder, then tear it
  // down and re-render, a cascading update React explicitly warns against.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [burners, setBurners] = useState<BurnerHandle[]>(() =>
    typeof window === "undefined" ? [] : listBurners(),
  );

  const refresh = useCallback(() => {
    setBurners(listBurners());
  }, []);

  const handleCreate = useCallback(() => {
    const burner = createBurner();
    refresh();
    onSelect?.(burner);
  }, [onSelect, refresh]);

  const handleForget = useCallback(
    (address: `0x${string}`) => {
      forgetBurner(address);
      refresh();
    },
    [refresh],
  );

  const handlePurge = useCallback(() => {
    purgeAll();
    refresh();
  }, [refresh]);

  if (!mounted) {
    // Server render must not touch the vault: there are no keys on the server.
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
          {keyCount()} in memory · never persisted
        </span>
      </div>

      <button
        type="button"
        onClick={handleCreate}
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
                    onClick={() => onSelect?.(burner)}
                    className="min-w-0 flex-1 text-left focus:outline-none"
                    aria-pressed={isSelected}
                  >
                    <span className="block font-mono text-[11px] text-slate-500">{burner.label}</span>
                    <span className="block truncate font-mono text-[12px] text-slate-200">{burner.address}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleForget(burner.address)}
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
          onClick={handlePurge}
          className="mt-3 w-full rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-500 transition-colors hover:border-red-900/70 hover:text-red-400"
        >
          Purge all keys from memory
        </button>
      )}
    </div>
  );
}
