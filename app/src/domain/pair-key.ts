import type { Address } from "./burner-route";

/**
 * Identity of one (token, burner) position.
 *
 * A burner is not the unit the ledger reasons about — the *pair* is. The same burner can hold
 * several tokens, and a sweep is authorised per `(token, burner)` in both contracts
 * (`_routes[token][burner]`, `_rules[token][burner]`). Keying anything by burner alone
 * collapses positions that the chain keeps apart, which is how a per-burner aggregate ends up
 * adding 6-decimal units to 18-decimal units.
 */
export function pairKey(token: Address, burner: Address): string {
  return `${token.toLowerCase()}:${burner.toLowerCase()}`;
}

/** The two fields every per-position read needs. */
export interface TokenBurnerPair {
  readonly token: Address;
  readonly burner: Address;
}
