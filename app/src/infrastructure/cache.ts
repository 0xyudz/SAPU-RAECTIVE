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

export function createCachedLoader<T>(options: {
  readonly build: () => Promise<T>;
  readonly freshMs: number;
  readonly staleMs: number;
}): CachedLoader<T> {
  let entry: Entry<T> | null = null;

  const start = (): Promise<T> => {
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
