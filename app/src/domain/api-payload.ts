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
 *
 * `StampedRead`/`visibleRead` below are the same rule for reads that are not polled by url but
 * triggered by form inputs (the Arm page's chain inspection and arm result). They live here
 * rather than in their own module because it is one rule, and two copies of it would drift.
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

/**
 * A read result stamped with the inputs it was produced for.
 *
 * `StampedPayload` above handles reads whose target is a url. The Arm page has reads whose
 * target is a *form*: `inspect()` reads `routeOf`/`ruleOf` for one (rsc, forwarder, burner,
 * token) tuple, and `armRoute()` reports the outcome of one (burner, token, cold wallet)
 * tuple. Both were plain `useState`, so changing the burner field left the previous burner's
 * route, allowance and pipeline on screen under the new address.
 *
 * That is the same failure as the stale balance, only worse: the on-chain panel rendered
 * "route.active true / allowance unlimited" for an address nobody had read, and the pipeline
 * header said "armed". Stamping makes the mismatch detectable instead of invisible.
 */
export interface StampedRead<T> {
  /** The inputs this value was read for. */
  readonly key: string;
  readonly value: T;
}

export function stampRead<T>(key: string, value: T): StampedRead<T> {
  return { key, value };
}

/**
 * Returns the stamped value only when it was read for `key`.
 *
 * A `null` key means the inputs are not all present yet (no burner, no token), so nothing can
 * be shown — there is no request the value could belong to.
 */
export function visibleRead<T>(stamped: StampedRead<T> | null, key: string | null): T | null {
  if (key === null) return null;
  if (stamped === null || stamped.key !== key) return null;
  return stamped.value;
}

/**
 * Builds the comparison key for a read whose inputs are addresses.
 *
 * Lowercased because the same address reaches the UI in both cases depending on its source —
 * `toAddress()` lowercases, the registry echoes what the config declares, and a checksummed
 * form is the same address. A key that differed by case would hide a fresh read as stale, or
 * (worse) match a stale one to a new target.
 *
 * Returns `null` when any part is missing, which makes every read for that target invisible.
 */
export function addressKey(parts: readonly (string | null)[]): string | null {
  if (parts.some((part) => part === null || part.length === 0)) return null;
  return parts.map((part) => (part as string).toLowerCase()).join("|");
}
