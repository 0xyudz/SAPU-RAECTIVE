import type { Tone } from "./tone";
import type { TokenMetadataResponse } from "./api-responses";

/**
 * What the app knows about the token the operator is actually arming.
 *
 * ## Why this is keyed to the typed address and not to `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS`
 *
 * The contracts are token-agnostic: `SapuForwarder` keys its rules by `(token, burner)` and
 * `SapuRSC` creates one subscription per `(token, burner)` with the token as the log filter.
 * So "which token" is an operator decision made in the Arm form, not a build-time constant —
 * and the metadata must therefore be read for the typed token, never for `/api/health`'s
 * configured one, which would record a route whose `tokenSymbol`/`tokenDecimals` describe some
 * other asset. That is the exact fabrication the guard in `armRoute` claims to prevent.
 *
 * `unread` and `failed` are deliberately distinct: `unread` means the endpoint answered but the
 * contract does not look like an ERC-20 (no code, or `symbol()`/`decimals()` reverted), which is a
 * fact about the token; `failed` means the read itself never completed, which is a fact about the
 * network. Collapsing them would tell the operator to fix the wrong thing.
 */
export type TokenMetadataRead =
  | { readonly kind: "no-token" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly reason: string }
  /** `eth_getCode` returned empty: nothing is deployed at this address. */
  | { readonly kind: "no-code" }
  /** Answered, but the address is not a readable ERC-20. `reason` names what was missing. */
  | { readonly kind: "unread"; readonly reason: string }
  | { readonly kind: "read"; readonly symbol: string; readonly decimals: number };

export interface TokenMetadataNotice {
  readonly note: string;
  readonly tone: Tone;
}

/** Longest symbol SAPU will render; longer responses are truncated rather than trusted. */
const MAX_SYMBOL_LENGTH = 32;

/**
 * Normalises a raw `symbol()` answer.
 *
 * Returns `null` when the answer cannot be a token symbol, so the caller reports "unreadable"
 * instead of rendering whatever bytes came back. A symbol that is empty, absurdly long, or
 * carries control characters would otherwise be printed straight into the route record.
 */
export function normaliseTokenSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Some legacy tokens (MKR and friends) return a right-padded `bytes32` from `symbol()`. viem
  // refuses to decode that as a `string` and throws, so it never reaches here as text; this
  // guard covers the remaining shapes — empty, control characters, or absurdly long.
  //
  // Trim first, then validate: padding whitespace around a real symbol is harmless, but a
  // control character *inside* it means the bytes are not a symbol and must not be rendered.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const printable = [...trimmed].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  if (!printable) return null;
  return trimmed.slice(0, MAX_SYMBOL_LENGTH);
}

/**
 * Normalises a raw `decimals()` answer.
 *
 * ERC-20 declares `uint8`, so anything outside `0..36` is a broken or non-ERC-20 contract.
 * `36` is the upper bound used elsewhere in the app (`createRoute`), and it is generous:
 * 18 is typical and 0 is legal.
 */
export function normaliseTokenDecimals(raw: unknown): number | null {
  const value = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > 36) return null;
  return value;
}

/**
 * The note beside the token field, plus the tone that colours it.
 *
 * Text and tone are returned together for the same reason `burnerBalanceNotice` does it: deriving
 * the colour from a substring of the text means a reword silently repaints a warning.
 *
 * A readable token is `muted` (informational). Everything else is `danger`, because arming against
 * an asset whose scale is unknown would record a route the chain does not describe.
 */
export function tokenMetadataNotice(
  read: TokenMetadataRead,
  originName: string,
): TokenMetadataNotice {
  switch (read.kind) {
    case "no-token":
      return { note: "no token address yet — enter the ERC-20 to sweep", tone: "muted" };
    case "pending":
      return { note: "reading symbol() and decimals() from the token…", tone: "muted" };
    case "failed":
      return {
        note: `token metadata could not be read (${read.reason}) — arm is blocked`,
        tone: "danger",
      };
    case "no-code":
      return {
        note: "no contract at this address on this chain — arm is blocked",
        tone: "danger",
      };
    case "unread":
      return { note: `${read.reason} — arm is blocked`, tone: "danger" };
    case "read":
      return {
        note: `${read.symbol} · ${read.decimals} decimals · ${originName}`,
        tone: "muted",
      };
  }
}

/**
 * Whether arming may proceed against the token currently in the form.
 *
 * Only a completed read of *this* address unlocks it. `canArm` on the page combines this with the
 * owner and burner conditions; keeping the metadata half here means the rule is testable without
 * React.
 */
export function tokenMetadataIsArmable(read: TokenMetadataRead): boolean {
  return read.kind === "read";
}

/**
 * Turns the endpoint payload into a `TokenMetadataRead`.
 *
 * Kept here rather than inline in the page for two reasons: the mapping is a rule (a `502` is a
 * transport failure, a `200`/`not-erc20` is a token fact) and rules belong where they can be
 * tested without React; and a nested `switch` inside the component defeats the React Compiler's
 * dependency inference, which then rejects the surrounding `useCallback`s.
 *
 * `error` is non-null only when the request failed, which is exactly the `unreachable` case that
 * `useApi` surfaces as an error rather than as data.
 */
export function tokenMetadataReadFrom(
  tokenAddress: string | null,
  payload: TokenMetadataResponse | null,
  error: string | null,
): TokenMetadataRead {
  if (tokenAddress === null) return { kind: "no-token" };
  if (payload === null) {
    return error === null ? { kind: "pending" } : { kind: "failed", reason: error };
  }
  switch (payload.status) {
    case "read":
      return { kind: "read", symbol: payload.symbol, decimals: payload.decimals };
    case "no-code":
      return { kind: "no-code" };
    case "not-erc20":
      return { kind: "unread", reason: payload.reason };
    case "unreachable":
      // `useApi` normally turns a 502 into `error` before this is reached. Kept so the union is
      // exhaustive rather than falling through to an invented state.
      return { kind: "failed", reason: payload.error };
  }
}

/** The `(symbol, decimals)` pair to record on the route, or `null` when it is not known. */
export function armableTokenMetadata(
  read: TokenMetadataRead,
): { readonly symbol: string; readonly decimals: number } | null {
  return read.kind === "read" ? { symbol: read.symbol, decimals: read.decimals } : null;
}
