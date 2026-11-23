import { describe, expect, it } from "vitest";
import { createCachedLoader } from "@/infrastructure/cache";

describe("createCachedLoader", () => {
  it("serves a value inside the fresh window without rebuilding", async () => {
    let builds = 0;
    const loader = createCachedLoader({
      build: async () => {
        builds += 1;
        return builds;
      },
      freshMs: 60_000,
      staleMs: 120_000,
    });

    expect(await loader.load()).toBe(1);
    expect(await loader.load()).toBe(1);
    expect(builds).toBe(1);
  });

  it("runs at most one build at a time", async () => {
    // This is the defect that exhausted the server heap: a slow build (`/api/ledger` takes
    // ~51 s) with a fast poll (every 15 s) started a fresh build on every request, so four
    // copies of the same index were being built and thrown away at once.
    let builds = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = () => (release as (() => void) | null)?.();

    const loader = createCachedLoader({
      build: async () => {
        builds += 1;
        await gate;
        return builds;
      },
      freshMs: 0,
      staleMs: 0,
    });

    const first = loader.load();
    const second = loader.load();
    const third = loader.load();

    expect(builds).toBe(1);
    open();

    const results = await Promise.all([first, second, third]);
    expect(builds).toBe(1);
    // All three callers see the same result rather than three different builds.
    expect(new Set(results).size).toBe(1);
  });

  it("re-serves the stale value while a single refresh runs in the background", async () => {
    let builds = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = () => (release as (() => void) | null)?.();

    const loader = createCachedLoader({
      build: async () => {
        builds += 1;
        if (builds > 1) await gate;
        return builds;
      },
      freshMs: 0,
      staleMs: 60_000,
    });

    expect(await loader.load()).toBe(1);

    // Inside the stale window each call answers immediately from the old value.
    expect(await loader.load()).toBe(1);
    expect(await loader.load()).toBe(1);
    expect(await loader.load()).toBe(1);

    // ...and they share one background refresh, not one per call.
    expect(builds).toBe(2);
    open();
  });

  it("retries after a failed build instead of caching the failure", async () => {
    let builds = 0;
    const loader = createCachedLoader({
      build: async () => {
        builds += 1;
        if (builds === 1) throw new Error("rpc down");
        return "ok";
      },
      freshMs: 60_000,
      staleMs: 120_000,
    });

    await expect(loader.load()).rejects.toThrow("rpc down");
    expect(await loader.load()).toBe("ok");
    expect(builds).toBe(2);
  });
});
