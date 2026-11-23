/**
 * Decides whether a polled payload may be shown for the *current* request target.
 *
 * ## The bug this prevents
 *
 * The Arm view polls `/api/balance?burner=…`. When the operator switches burners the url
 * changes, but a plain `useState` keeps the previous payload until the next response lands.
 * For a few hundred milliseconds the panel rendered burner A's balance under burner B's
 * address — a claim about the chain that was simply false, and the exact class of bug this
 * app refuses to ship.
 *
 * Stamping every payload with the url that produced it makes the mismatch detectable: a
 * payload from a different url is treated as absent, so the UI shows "loading" instead of a
 * stale number under a new label.
 *
 * Kept as a pure function so the rule is testable without React or a fake timer.
 */
export interface StampedPayload<T> {
  /** The url this payload came from. */
  readonly url: string | null;
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

export interface VisiblePayload<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/**
 * Returns the payload to render for `url`.
 *
 * - a payload stamped with a different url is invisible, and `loading` is reported so the
 *   caller does not briefly claim "no data";
 * - a `null` url means "polling suspended", which is neither loading nor an error;
 * - a matching payload is returned as-is, including its own error state.
 */
export function visiblePayload<T>(
  payload: StampedPayload<T> | null,
  url: string | null,
): VisiblePayload<T> {
  if (url === null) return { data: null, error: null, loading: false };
  if (payload === null || payload.url !== url) {
    return { data: null, error: null, loading: true };
  }
  return { data: payload.data, error: payload.error, loading: payload.loading };
}
