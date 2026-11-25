"use client";

import { POLL_INTERVAL_MS } from "@/config/constants";
import type { TokenMetadataResponse } from "@/domain/api-responses";
import type { Address } from "@/domain/burner-route";
import type { Tone } from "@/domain/tone";
import {
  armableTokenMetadata,
  tokenMetadataIsArmable,
  tokenMetadataNotice,
  tokenMetadataReadFrom,
  type TokenMetadataRead,
} from "@/domain/token-metadata";
import { useApi } from "@/components/use-api";

export interface TokenMetadataState {
  /** What is known about the token currently in the form. */
  readonly read: TokenMetadataRead;
  /** The note to show beside the token field, with its tone. */
  readonly notice: { readonly note: string; readonly tone: Tone };
  /** `symbol()` of the token in the form, or null when it was not read. */
  readonly symbol: string | null;
  /** `decimals()` of the token in the form, or null when it was not read. */
  readonly decimals: number | null;
  /** Whether the metadata allows arming this token. */
  readonly armable: boolean;
}

/**
 * Reads `symbol()`/`decimals()` for the token **in the form**, not for the configured one.
 *
 * `/api/health` reports `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS`, which is only the deployment's default.
 * The contracts key everything by `(token, burner)` — `SapuRSC` subscribes with the token as the
 * log filter and `SapuForwarder` stores the rule under it — so which ERC-20 to sweep is an
 * operator decision made in the Arm form. Taking the metadata from the configured token would
 * record a route whose symbol and decimals describe a different asset, which is exactly the
 * fabrication the guard in `armRoute` exists to prevent.
 *
 * This is a separate request from the balance: balance needs a burner, metadata does not.
 * Folding them together left the hint stuck on "reading…" until a burner was selected, which is
 * the wrong order for a form filled top-down.
 *
 * This is a hook rather than inline code in the page because the page's own callbacks
 * (`readSnapshot`, `inspect`, `run`) are manually memoised, and the React Compiler refuses to
 * preserve that memoisation once the component body grows past what it can infer. Keeping this
 * wiring in a hook keeps the page within that budget while leaving the rule itself in
 * `domain/token-metadata.ts`, where it is tested without React.
 *
 * `useApi` stamps each payload with the url that produced it, so a response for a previously
 * typed address is discarded rather than briefly shown under the new one.
 */
export function useTokenMetadata(
  tokenAddress: Address | null,
  originName: string,
): TokenMetadataState {
  const api = useApi<TokenMetadataResponse>(
    tokenAddress === null ? null : `/api/token?token=${tokenAddress}`,
    POLL_INTERVAL_MS.ledger,
  );

  const read = tokenMetadataReadFrom(tokenAddress, api.data, api.error);
  const armableMetadata = armableTokenMetadata(read);

  return {
    read,
    notice: tokenMetadataNotice(read, originName),
    symbol: armableMetadata?.symbol ?? null,
    decimals: armableMetadata?.decimals ?? null,
    armable: tokenMetadataIsArmable(read),
  };
}
