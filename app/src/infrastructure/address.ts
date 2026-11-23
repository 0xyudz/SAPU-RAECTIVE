import type { Address } from "@/domain/burner-route";

/**
 * Normalising addresses that came out of a chain read.
 *
 * ## Why this is one module instead of a helper per file
 *
 * Six modules each defined their own `lower` or `asAddress` with the identical body. That is
 * harmless until one of them changes — a trim, a checksum check, a validation — and the app
 * then compares a normalised address against a non-normalised one and silently reports a
 * cold-wallet mismatch that does not exist. One definition removes that class of drift.
 *
 * ## Why these do not validate
 *
 * `domain/burner-route.ts` has `toAddress`, which validates and throws. That is the right
 * behaviour for operator input. These functions are for values the node already returned:
 * viem has decoded them from ABI-typed `address` fields, so a malformed value is not a
 * plausible input, and throwing here would turn a decode quirk into a failed index. When a
 * value genuinely is not an address, `asAddress` still produces something that simply will
 * not compare equal to a real address — a wrong row, not a crash that hides every other row.
 */

/** Lowercase a string known to be an address. */
export function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

/**
 * Lowercase an address that arrived as `unknown`.
 *
 * Used where a decoded log argument or a loosely-typed contract return is read: the value is
 * an address at runtime, but the decoder hands it back as `unknown`, so a cast is unavoidable.
 */
export function asAddress(value: unknown): Address {
  return String(value).toLowerCase() as Address;
}

/** The zero address, as it appears in contract returns that mean "unset". */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** True when a value is the zero address. `null` is not the zero address: it is unknown. */
export function isZeroAddress(value: string | null): boolean {
  return value !== null && value.toLowerCase() === ZERO_ADDRESS;
}
