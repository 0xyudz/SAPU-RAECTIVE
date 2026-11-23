interface Entry<T> {
  readonly at: number;
  readonly promise: Promise<T>;
  readonly value: T | null;
}

export interface CachedLoader<T> {
  readonly load: () => Promise<T>;
  readonly peek: () => T | null;
  readonly clear: () => void;
}

/**
 * A single-flight, stale-while-revalidate cache.
 *
 * ## Why `inFlight` exists
 *
 * The original version started a fresh build on every `load()` once the value was older
 * than `freshMs`, without checking whether a build was already running. A slow build made
 * that fatal: `/api/ledger` takes ~51 s, the page polls every 15 s, so four builds of the
 * same index ran at once, each allocating its own log arrays, and they overwrote each
 * other's result when they landed. Under a long-lived server that was enough to exhaust
 * the heap. At most one build may be in flight; concurrent callers share it.
 */
export function createCachedLoader<T>(options: {
  readonly build: () => Promise<T>;
  readonly freshMs: number;
  readonly staleMs: number;
}): CachedLoader<T> {
  let entry: Entry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  const start = (): Promise<T> => {
    // Single flight: a caller that arrives mid-build joins it instead of starting another.
    if (inFlight !== null) return inFlight;

    const promise = options.build().then(
      (value) => {
        entry = { at: Date.now(), promise, value };
        return value;
      },
      (error: unknown) => {
        if (entry?.promise === promise) entry = null;
        throw error;
      },
    );

    inFlight = promise;
    const settle = () => {
      if (inFlight === promise) inFlight = null;
    };
    void promise.then(settle, settle);

    // Placeholder so a concurrent `load()` sees a pending build and returns its promise
    // rather than treating the cache as empty and starting a second one.
    entry = { at: entry?.at ?? 0, promise, value: entry?.value ?? null };
    return promise;
  };

  return {
    async load() {
      if (entry === null) return start();
      if (entry.value === null) return entry.promise;

      const age = Date.now() - entry.at;
      if (age < options.freshMs) return entry.value;
      if (age < options.staleMs) {
        // Serve the stale value now, refresh in the background. `start()` is single-flight,
        // so repeated polls cannot stack refreshes.
        void start().catch(() => undefined);
        return entry.value;
      }
      return start();
    },
    peek() {
      return entry?.value ?? null;
    },
    clear() {
      entry = null;
    },
  };
}
