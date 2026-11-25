"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

/**
 * How much of the operator surface to show.
 *
 * `simple` is the default because the first question a visitor has is "did this actually
 * work?", and the answer is one number plus a short table. `operator` is the view the
 * deployment's own owner needs: every column, every counter, every repair path.
 *
 * The two modes render the same facts. Nothing is hidden from `simple` that would make a
 * claim look better than it is — the incomplete columns are dropped because they are empty
 * or redundant for the rows on screen, never because they are unflattering.
 */
export type SurfaceMode = "simple" | "operator";

const STORAGE_KEY = "sapu.surface.mode";

/**
 * The preference lives in `localStorage`, which is external state, so it is read through
 * `useSyncExternalStore` rather than copied into React state by an effect. The effect version
 * both tripped the `set-state-in-effect` rule and produced a second render on every mount.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** `localStorage` throws in a blocked-storage context; a preference is not worth a crash. */
function getSnapshot(): SurfaceMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "operator" ? "operator" : "simple";
  } catch {
    return "simple";
  }
}

/** The server cannot know the visitor's choice, so it renders the default and hydrates into it. */
function getServerSnapshot(): SurfaceMode {
  return "simple";
}

function writeMode(next: SurfaceMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // A preference that cannot be stored still applies to this page view.
  }
  for (const listener of listeners) listener();
}

interface SurfaceModeValue {
  readonly mode: SurfaceMode;
  readonly setMode: (mode: SurfaceMode) => void;
}

const SurfaceModeContext = createContext<SurfaceModeValue | null>(null);

export function SurfaceModeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = useMemo<SurfaceModeValue>(() => ({ mode, setMode: writeMode }), [mode]);

  return <SurfaceModeContext.Provider value={value}>{children}</SurfaceModeContext.Provider>;
}

export function useSurfaceMode(): SurfaceModeValue {
  const value = useContext(SurfaceModeContext);
  if (value === null) {
    throw new Error("useSurfaceMode must be used inside SurfaceModeProvider");
  }
  return value;
}

/** Two-state switch. Rendered as buttons rather than a checkbox so both labels are visible. */
export function SurfaceModeToggle() {
  const { mode, setMode } = useSurfaceMode();
  return (
    <div
      className="inline-flex items-center rounded border border-steel p-0.5 font-mono text-[10.5px]"
      role="group"
      aria-label="Detail level"
      title="Simple shows the evidence in one screen. Operator shows every column and counter."
    >
      {(["simple", "operator"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => setMode(candidate)}
          aria-pressed={mode === candidate}
          className={`rounded px-2 py-1 transition-colors ${
            mode === candidate ? "bg-lime/10 text-lime-glow" : "text-slate-500 hover:text-slate-300"
          }`}
        >
          {candidate}
        </button>
      ))}
    </div>
  );
}
