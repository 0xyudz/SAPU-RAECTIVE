"use client";


import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useApi<T>(url: string, intervalMs: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch(url, { cache: "no-store" });
        const body = (await response.json()) as unknown;
        if (cancelled) return;

        if (!response.ok) {
          const message =
            typeof body === "object" && body !== null && "error" in body
              ? String((body as { error?: unknown }).error ?? `HTTP ${response.status}`)
              : `HTTP ${response.status}`;
          setError(message);
          return;
        }

        setData(body as T);
        setError(null);
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "request failed");
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [url, intervalMs, nonce]);

  return { data, error, loading, refresh };
}
