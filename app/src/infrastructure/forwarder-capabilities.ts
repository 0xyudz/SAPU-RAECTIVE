import type { Address } from "@/domain/burner-route";
import { contractTarget } from "./contracts";
import { withRpcRetry } from "./rpc-retry";

/**
 * Which optional forwarder features the *deployed* contract actually implements.
 *
 * The app ships against a forwarder that may or may not have been redeployed with
 * the rescue path. Rather than assume, each capability is detected from the deployed
 * bytecode. A capability that cannot be determined is reported as `null`, never as
 * `false`, so the UI can say "unknown" instead of inventing a negative.
 */
export interface ForwarderCapabilities {
  /** `true` when the deployed bytecode dispatches `rescueSweep`. `null` when unreadable. */
  readonly rescueSweep: boolean | null;
}

export const UNKNOWN_CAPABILITIES: ForwarderCapabilities = { rescueSweep: null };

/**
 * Detects `rescueSweep` support from the deployed runtime bytecode.
 *
 * ## Why bytecode and not a probe call
 *
 * A missing function has no dispatcher entry, so the call falls through to the
 * fallback. `SapuForwarder` has no fallback, which makes both a real function that
 * reverts in `onlyOwner` and an absent function revert with empty data — the node
 * reports the same "execution reverted" either way. The revert is therefore not a
 * usable discriminator.
 *
 * The solc dispatcher compares `msg.sig` against a `PUSH4 <selector>` for every
 * external function, so the selector bytes appear in the runtime code exactly when
 * the function exists. Searching for the four bytes is a direct, positive test.
 */
export async function readForwarderCapabilities(forwarder: Address): Promise<ForwarderCapabilities> {
  const target = contractTarget("forwarder");

  let code: string | undefined;
  try {
    code = await withRpcRetry(() => target.client.getCode({ address: forwarder }));
  } catch {
    return UNKNOWN_CAPABILITIES;
  }

  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    return UNKNOWN_CAPABILITIES;
  }

  return { rescueSweep: code.toLowerCase().includes(RESCUE_SWEEP_SELECTOR) };
}

/**
 * `bytes4(keccak256("rescueSweep(address,address)"))`, without the `0x` prefix so it
 * can be searched for directly inside a hex bytecode string.
 * Verified against viem's `toFunctionSelector`, not typed by hand.
 */
const RESCUE_SWEEP_SELECTOR = "1d0e8bf2";
