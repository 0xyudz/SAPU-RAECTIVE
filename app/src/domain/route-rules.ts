export {
  DEFAULT_ROUTE_RULES,
  validateRules,
  meetsMinimum,
  InvalidRouteError,
} from "./burner-route";
export type { RouteRules } from "./burner-route";

import type { BaseUnits, RouteRules } from "./burner-route";

export const ZERO: BaseUnits = "0";

export function shouldDisarm(rules: RouteRules, sweepCount: number): boolean {
  if (rules.sweepContinuously) return false;
  return sweepCount >= (rules.maxSweeps ?? 1);
}

export function disarmReason(rules: RouteRules, sweepCount: number): string | null {
  if (!shouldDisarm(rules, sweepCount)) return null;
  if (rules.maxSweeps !== null) {
    return `Reached the ${rules.maxSweeps}-sweep cap for this route.`;
  }
  return "This route was armed for a single sweep.";
}
