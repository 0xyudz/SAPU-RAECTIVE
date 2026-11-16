/**
 * Domain: BurnerRoute
 *
 * A `BurnerRoute` is the unit of intent a user expresses once and forgets about.
 * It binds three things: a burner address that receives funds, a cold wallet that
 * ultimately holds them, and the token being watched.
 *
 * This module is deliberately free of I/O, React, and `viem` types. The domain
 * must be testable without a chain, and the same rules must apply whether they are
 * evaluated in a browser, a script, or a future mobile client.
 */

/** A lowercase 0x-prefixed 20-byte hex address. */
export type Address = `0x${string}`;

/** A token amount in base units, as a decimal string (never a JS number). */
export type BaseUnits = string;

/** Lifecycle of a route. Mirrors the two contracts that must both be armed. */
export type RouteStatus =
  | "draft"
  | "armed"
  | "watching"
  | "swept"
  | "revoked";

export interface BurnerRoute {
  /** Burner/stealth address that receives deposits. */
  readonly burner: Address;
  /** Cold storage destination for swept funds. */
  readonly coldWallet: Address;
  /** ERC-20 being watched. */
  readonly token: Address;
  /** Human label for the token, for UI only. */
  readonly tokenSymbol: string;
  /** Token decimals, needed to render base units. */
  readonly tokenDecimals: number;
  /** Origin chain id (Base Sepolia = 84532). */
  readonly chainId: number;
  /** Current lifecycle stage. */
  readonly status: RouteStatus;
  /** Unix seconds when the route was armed. */
  readonly armedAt: number;
}

export interface RouteRules {
  /** Minimum deposit, in base units, that is worth a callback. */
  readonly minDeposit: BaseUnits;
  /** Maximum number of sweeps to perform for this route. `null` = unlimited. */
  readonly maxSweeps: number | null;
  /** Whether to keep watching after the first successful sweep. */
  readonly sweepContinuously: boolean;
}

/**
 * Sensible defaults. A burner is usually a one-shot address, but ERC-5564 stealth
 * addresses can receive repeatedly, so continuous sweeping is the safer default:
 * funds never sit unattended waiting for a manual second action.
 */
export const DEFAULT_ROUTE_RULES: RouteRules = {
  minDeposit: "1",
  maxSweeps: null,
  sweepContinuously: true,
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function toAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new InvalidRouteError(`Not a valid address: ${value}`);
  }
  return value.toLowerCase() as Address;
}

export class InvalidRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRouteError";
  }
}

export interface CreateRouteInput {
  burner: string;
  coldWallet: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  chainId: number;
  rules?: Partial<RouteRules>;
}

export interface ValidatedRoute {
  readonly route: BurnerRoute;
  readonly rules: RouteRules;
}

/**
 * Validates and normalises a route request.
 *
 * The single most important rule here: **burner and cold wallet must differ.**
 * A route pointing a burner at itself is a no-op that silently burns gas on every
 * deposit — the funds land and are immediately "swept" to the same address. It is
 * also a strong signal the user pasted the wrong field, so it is rejected loudly
 * rather than accepted as a degenerate case.
 */
export function createRoute(input: CreateRouteInput): ValidatedRoute {
  const burner = toAddress(input.burner);
  const coldWallet = toAddress(input.coldWallet);
  const token = toAddress(input.token);

  if (burner === coldWallet) {
    throw new InvalidRouteError(
      "Burner and cold wallet must be different addresses — otherwise the sweep moves funds nowhere.",
    );
  }

  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new InvalidRouteError(`Invalid chain id: ${input.chainId}`);
  }

  if (!Number.isInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 36) {
    throw new InvalidRouteError(`Invalid token decimals: ${input.tokenDecimals}`);
  }

  if (input.tokenSymbol.trim().length === 0) {
    throw new InvalidRouteError("Token symbol is required.");
  }

  const rules: RouteRules = { ...DEFAULT_ROUTE_RULES, ...input.rules };
  validateRules(rules);

  return {
    route: {
      burner,
      coldWallet,
      token,
      tokenSymbol: input.tokenSymbol.trim().toUpperCase(),
      tokenDecimals: input.tokenDecimals,
      chainId: input.chainId,
      status: "draft",
      armedAt: 0,
    },
    rules,
  };
}

export function validateRules(rules: RouteRules): void {
  if (!/^\d+$/.test(rules.minDeposit)) {
    throw new InvalidRouteError("minDeposit must be a non-negative integer in base units.");
  }
  if (rules.maxSweeps !== null && (!Number.isInteger(rules.maxSweeps) || rules.maxSweeps < 1)) {
    throw new InvalidRouteError("maxSweeps must be null or a positive integer.");
  }
}

/** Returns a copy of the route moved to a new status, with `armedAt` stamped once. */
export function transition(route: BurnerRoute, status: RouteStatus, nowSeconds: number): BurnerRoute {
  const armedAt = route.armedAt === 0 && status === "armed" ? nowSeconds : route.armedAt;
  return { ...route, status, armedAt };
}

/** True when a deposit amount clears the route's minimum. */
export function meetsMinimum(amount: BaseUnits, rules: RouteRules): boolean {
  if (!/^\d+$/.test(amount)) return false;
  // Compare as BigInt: base-unit amounts routinely exceed Number.MAX_SAFE_INTEGER.
  return BigInt(amount) >= BigInt(rules.minDeposit);
}
