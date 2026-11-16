/**
 * Domain: RouteRules
 *
 * Re-exported alongside the rule predicates so the domain surface reads cleanly as
 * `burner-route` (identity), `route-rules` (policy), `sweep-receipt` (evidence).
 */
export {
  DEFAULT_ROUTE_RULES,
  validateRules,
  meetsMinimum,
  InvalidRouteError,
} from "./burner-route";
export type { RouteRules } from "./burner-route";

import type { BaseUnits, RouteRules } from "./burner-route";

/** Zero in base units, as a string. */
export const ZERO: BaseUnits = "0";

/**
 * Decides whether a route should be disarmed after a sweep.
 *
 * A one-shot burner should stop watching once it has been emptied: leaving the
 * subscription live costs the operator REACT on every future transfer that touches
 * the address, including dust sent by an attacker trying to grief the route.
 */
export function shouldDisarm(rules: RouteRules, sweepCount: number): boolean {
  if (rules.sweepContinuously) return false;
  return sweepCount >= (rules.maxSweeps ?? 1);
}

/**
 * Explains why a route is not sweeping, for the UI's status line.
 *
 * Returning a reason rather than a bare boolean keeps the explanation next to the
 * rule that produced it, so the UI never has to re-derive policy.
 */
export function disarmReason(rules: RouteRules, sweepCount: number): string | null {
  if (!shouldDisarm(rules, sweepCount)) return null;
  if (rules.maxSweeps !== null) {
    return `Reached the ${rules.maxSweeps}-sweep cap for this route.`;
  }
  return "This route was armed for a single sweep.";
}
