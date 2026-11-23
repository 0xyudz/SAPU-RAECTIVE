"use client";

import { useCallback, useEffect, useState } from "react";

export interface ApiState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Polls a JSON endpoint.
 *
 * `url` may be `null` when the endpoint's inputs are not ready yet (no burner selected, no
 * token configured). That is not the same as an empty string: `fetch("")` would request the
 * current page and parse its HTML as JSON, so a `null` url simply suspends polling and
 * reports `loading: false` with no data.
 */
export function useApi<T>(url: string | null, intervalMs: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (url === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;

      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
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
        if (cancelled) return;
        const message =
          fetchError instanceof DOMException && fetchError.name === "TimeoutError"
            ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : fetchError instanceof Error
              ? fetchError.message
              : "request failed";
        setError(message);
      } finally {
        inFlight = false;
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

  return { data, error, loading: url === null ? false : loading, refresh };
}
