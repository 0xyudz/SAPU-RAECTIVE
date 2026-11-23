export type Address = `0x${string}`;

export type BaseUnits = string;

export type RouteStatus =
  | "draft"
  | "armed"
  | "watching"
  | "swept"
  | "revoked";

export interface BurnerRoute {
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly token: Address;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly chainId: number;
  readonly status: RouteStatus;
  readonly armedAt: number;
}

/**
 * The policy a registration carries.
 *
 * `minDeposit` is the only rule, and it is deliberately the only one: it is validated
 * here and documented as **not enforced on-chain** (see docs/LIMITATIONS.md). A cap on
 * the number of sweeps used to live here too, but nothing ever enforced it and nothing
 * could - there is no store for it, and `SapuRSC.sweepCount` is a global counter rather
 * than a per-route one. It was removed rather than left as a promise the product could
 * not keep.
 */
export interface RouteRules {
  readonly minDeposit: BaseUnits;
}

export const DEFAULT_ROUTE_RULES: RouteRules = {
  minDeposit: "1",
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
}

export function transition(route: BurnerRoute, status: RouteStatus, nowSeconds: number): BurnerRoute {
  const armedAt = route.armedAt === 0 && status === "armed" ? nowSeconds : route.armedAt;
  return { ...route, status, armedAt };
}
