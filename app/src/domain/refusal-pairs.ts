import type { Address } from "./burner-route";

/**
 * A registry row reduced to what refusal-pair selection needs.
 *
 * `forwarderArmed` is deliberately part of the *pair*, not of the burner. The forwarder stores
 * its rule under `(token, burner)`, so one burner can be armed for USDC and unarmed for SAPU at
 * the same time. Any code that reads armedness off the burner alone is describing a fact the
 * contract does not have.
 */
export interface RefusalCandidate {
  readonly token: Address;
  readonly burner: Address;
  /** `forwarder.ruleOf(token, burner).armed` — armedness of this pair, not of the burner. */
  readonly forwarderArmed: boolean;
  /** Cold wallet the route was armed with, when the registry observed one. */
  readonly coldWallet: Address | null;
}

export interface RefusalPair {
  readonly burner: Address;
  readonly coldWallet: Address;
}

export interface RefusalPairSelection {
  /** A pair that is *not* armed for the probed token, so `executeSweep` reverts `RouteNotArmed`. */
  readonly disarmed: RefusalPair;
  /**
   * An armed pair for the probed token with a zero balance, so `executeSweep` reverts
   * `NothingToSweep`. Null when no such pair exists.
   */
  readonly zeroBalance: RefusalPair | null;
  /**
   * True when the disarmed pair is synthetic rather than taken from the registry, because no
   * unarmed pair exists for this token. Reported so the page can say so instead of implying it
   * exercised a real route.
   */
  readonly disarmedIsSynthetic: boolean;
}

/**
 * Chooses which token the lab probes.
 *
 * ## Why this is a separate decision
 *
 * The `zero-balance` case is only meaningful against a pair the forwarder actually has a rule
 * for: with no rule, `executeSweep` reverts earlier at `RouteNotArmed` and the `NothingToSweep`
 * branch is never reached. So the lab probes the token with the most armed routes, preferring
 * the configured token on a tie so the default deployment stays the default subject.
 *
 * This is exported separately because the balances have to be read for *this* token before the
 * pairs can be chosen, and reading is the caller's job — a domain module that performed IO
 * could not be tested against the mismatch this exists to prevent.
 */
export function probeToken(
  rows: readonly RefusalCandidate[],
  configuredToken: Address | null,
): Address {
  const armedCount = new Map<string, { token: Address; count: number }>();
  for (const row of rows) {
    if (!row.forwarderArmed) continue;
    const key = row.token.toLowerCase();
    const entry = armedCount.get(key);
    if (entry === undefined) {
      armedCount.set(key, { token: row.token, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  const candidates = [...armedCount.values()];
  if (candidates.length === 0) {
    // No armed route at all. The lab still has something to prove — the caller-authorization
    // cases do not depend on a route — so it probes the configured token, or the first token
    // the registry knows, rather than refusing to run.
    return configuredToken ?? rows[0]?.token ?? "0x0000000000000000000000000000000000000000";
  }

  const configured = configuredToken?.toLowerCase() ?? null;
  candidates.sort((a, b) => {
    if (configured !== null) {
      const aIsConfigured = a.token.toLowerCase() === configured ? 0 : 1;
      const bIsConfigured = b.token.toLowerCase() === configured ? 0 : 1;
      if (aIsConfigured !== bIsConfigured) return aIsConfigured - bIsConfigured;
    }
    if (a.count !== b.count) return b.count - a.count;
    return a.token.localeCompare(b.token);
  });

  return candidates[0]!.token;
}

/**
 * Chooses the two pairs the route-dependent refusal cases run against.
 *
 * ## The bug this replaces
 *
 * The route used to pick the burner from any row with `forwarderArmed` and take the token from
 * configuration — two independent choices over a fact that is a *pair*. A burner armed only for
 * USDC could then be simulated against SAPU, so `executeSweep` reverted `RouteNotArmed` while the
 * card promised `NothingToSweep`. On the live deployment the chosen burner happened to be armed
 * for all three tokens, so the output looked correct for the wrong reason.
 *
 * Every pair returned here belongs to `token`, and every balance is looked up by `(token, burner)`
 * rather than by burner alone.
 */
export function selectRefusalPairs(
  rows: readonly RefusalCandidate[],
  token: Address,
  balances: ReadonlyMap<string, bigint | null>,
  fallback: RefusalPair,
): RefusalPairSelection {
  const forToken = rows.filter((row) => row.token.toLowerCase() === token.toLowerCase());

  const armed = forToken.filter((row) => row.forwarderArmed);
  const zeroBalanceRow =
    armed.find((row) => balances.get(pairKey(row.token, row.burner)) === 0n) ?? null;

  const unarmedRow = forToken.find((row) => !row.forwarderArmed) ?? null;

  const zeroBalance: RefusalPair | null =
    zeroBalanceRow === null
      ? null
      : {
          burner: zeroBalanceRow.burner,
          // A rule with no recorded cold wallet cannot be swept, so it cannot demonstrate
          // `NothingToSweep` either. The fallback is only used for the cold-wallet field, which
          // the case passes through to a call that reverts before reading it.
          coldWallet: zeroBalanceRow.coldWallet ?? fallback.coldWallet,
        };

  if (unarmedRow === null) {
    return { disarmed: fallback, zeroBalance, disarmedIsSynthetic: true };
  }

  return {
    disarmed: {
      burner: unarmedRow.burner,
      coldWallet: unarmedRow.coldWallet ?? fallback.coldWallet,
    },
    zeroBalance,
    disarmedIsSynthetic: false,
  };
}

/** Key for a balance lookup. The pair is the identity, never the burner alone. */
export function pairKey(token: Address, burner: Address): string {
  return `${token.toLowerCase()}:${burner.toLowerCase()}`;
}
