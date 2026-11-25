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
 * There is no route policy type, and that is the honest state of the product.
 *
 * Two fields were deliberately not carried forward in a `RouteRules` interface, because both
 * would be promises nothing could keep:
 *
 *  - `maxSweeps` — no store for it exists, and `SapuRSC.sweepCount` is a global counter
 *    rather than a per-route one.
 *  - `minDeposit` — it was validated and unit-tested, but `SapuRSC.react` requests a
 *    callback for any non-zero amount, so no deposit was ever filtered by it. A rule that
 *    cannot be enforced and is never read is dead weight, not a safeguard.
 *
 * The dust-griefing vector `minDeposit` was meant to address is real, and it is documented
 * as an unmitigated limitation in docs/LIMITATIONS.md §6, where a reader will look for it.
 */

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
}

export interface ValidatedRoute {
  readonly route: BurnerRoute;
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
  };
}

export function transition(route: BurnerRoute, status: RouteStatus, nowSeconds: number): BurnerRoute {
  const armedAt = route.armedAt === 0 && status === "armed" ? nowSeconds : route.armedAt;
  return { ...route, status, armedAt };
}
