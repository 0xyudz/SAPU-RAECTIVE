import type { Address } from "./burner-route";

/**
 * The value of the "type an address" option in the token picker.
 *
 * Arming a token that has never been routed is the normal case for a new asset, and such a
 * token cannot appear in a list built from on-chain history. So the picker is a list **plus**
 * an escape hatch, never a closed set: a dropdown that cannot express "a token nobody has
 * armed yet" would make the multi-token capability narrower than the contracts allow.
 */
export const CUSTOM_TOKEN_VALUE = "__custom__";

export interface TokenChoice {
  readonly address: Address;
  /** `symbol()` read from the token contract, or null when it was not read. */
  readonly symbol: string | null;
  /** `decimals()` read from the token contract. Null means unreadable, not 18. */
  readonly decimals: number | null;
  /**
   * Where the option came from.
   *
   * `registry` means the registry observed this token in a `RouteRegistered`/`RouteArmed`
   * event, so its metadata was read from the token contract. `configured` is the deployment's
   * default token: a real deployment fact, but one the registry may never have seen if no
   * route for it was registered inside the scanned window.
   */
  readonly source: "registry" | "configured";
}

/**
 * Builds the token picker's options from what the chain actually reports.
 *
 * SAPU is token-agnostic: `SapuRSC` keys subscriptions by `(token, burner)` and
 * `SapuForwarder` stores rules under the same pair, so "which ERC-20" is an operator decision.
 * A built-in list of USDC/WETH addresses would be exactly the hardcoded fixture this codebase
 * forbids — and it would be wrong on every chain except the one it was copied from.
 *
 * So the options are derived from data the registry already read from the chain: one entry per
 * token it has seen, carrying that token's own `symbol()`/`decimals()`. The deployment's
 * configured token is added as a fallback so a fresh deployment still has one usable option
 * before any route exists.
 *
 * Duplicates collapse by address: two burners routing the same token are one asset, and a
 * token that is both configured and in the registry appears once, marked `configured`.
 *
 * Ordering is configured-first (it is the default), then by symbol so the list is stable across
 * polls rather than reshuffling as rows arrive.
 */
export function tokenChoices(
  observations: readonly {
    readonly token: Address;
    readonly tokenSymbol: string | null;
    readonly tokenDecimals: number | null;
  }[],
  configuredToken: Address | null,
): readonly TokenChoice[] {
  const byAddress = new Map<string, TokenChoice>();

  for (const row of observations) {
    const key = row.token.toLowerCase();
    if (byAddress.has(key)) continue;
    byAddress.set(key, {
      address: key as Address,
      symbol: row.tokenSymbol,
      decimals: row.tokenDecimals,
      source: "registry",
    });
  }

  if (configuredToken !== null) {
    const key = configuredToken.toLowerCase();
    const existing = byAddress.get(key);
    byAddress.set(key, {
      address: key as Address,
      symbol: existing?.symbol ?? null,
      decimals: existing?.decimals ?? null,
      source: "configured",
    });
  }

  return [...byAddress.values()].sort((a, b) => {
    const aRank = a.source === "configured" ? 0 : 1;
    const bRank = b.source === "configured" ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return (a.symbol ?? a.address).localeCompare(b.symbol ?? b.address);
  });
}

/**
 * The metadata half of an option's label.
 *
 * The address is appended by the caller, which already owns the shortening helper. Returning
 * only the descriptive part keeps this module free of presentation concerns — and free of an
 * import from `components/`, which would invert the layering.
 *
 * An unreadable symbol is named as such rather than omitted: "symbol unreadable" tells the
 * operator the picker is showing a raw address for a reason, while a bare address looks like a
 * token that simply has no ticker.
 */
export function tokenChoiceLabel(choice: TokenChoice): string {
  if (choice.symbol === null) return "symbol unreadable";
  return choice.decimals === null ? choice.symbol : `${choice.symbol} · ${choice.decimals} dp`;
}

/**
 * Which control the token field should show.
 *
 * `pending` is a real third state, not a synonym for `custom`:
 *
 *   - `pending`  the source of the options has not answered yet. Show the field disabled with a
 *                "reading" placeholder, because there is nothing truthful to select.
 *   - `known`    the value names one of the options. Show the dropdown on that option.
 *   - `custom`   the operator is on the free-text path: either they picked the escape hatch
 *                (which clears the value) or they typed an address nobody has routed yet.
 *
 * Deriving the mode from "does this value match an option?" alone cannot express `pending`: on a
 * cold load the value is empty and `choices` is empty, so nothing matches and the field would
 * announce "Other ERC-20" and open an empty address box before the registry has answered.
 *
 * `ready` is a parameter and not inferred from `value` for the same reason. The escape hatch
 * works by clearing the value, so "empty" means two different things: "nothing has arrived yet"
 * and "the operator asked to type an address". The caller knows which it is, so it says so.
 */
export type TokenPickerMode = "known" | "custom" | "pending";

export function tokenPickerMode(
  value: string,
  choices: readonly TokenChoice[],
  ready: boolean,
): TokenPickerMode {
  if (!ready) return "pending";
  if (value === "") return "custom";
  const known = choices.find((choice) => choice.address.toLowerCase() === value.toLowerCase());
  return known === undefined ? "custom" : "known";
}
