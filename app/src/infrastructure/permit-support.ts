import type { Address } from "@/domain/burner-route";
import { contractTarget } from "./contracts";
import { withRpcRetry } from "./rpc-retry";

/**
 * Whether a token implements EIP-2612, as far as can be told from its deployed bytecode.
 *
 * `armWithPermit` is the only way SAPU grants the forwarder an allowance without a second
 * wallet signature, and it needs the token to expose `permit` and `nonces`. A token that does
 * not implement them makes the call revert during simulation — and because the revert carries
 * no reason string, the operator sees a raw "execution reverted" with no clue that the *token*
 * is the problem, not their inputs.
 *
 * Detecting it up front lets the app say "this token has no permit, fund it first and approve
 * from the burner" instead of surfacing an unexplained revert.
 *
 * `null` means the question could not be answered (bytecode unreadable, or no contract at the
 * address). It is never reported as `false`, so the UI cannot invent a negative.
 */
export type PermitSupport = boolean | null;

/**
 * Selectors, verified with viem's `toFunctionSelector` rather than typed by hand.
 * Stored without the `0x` prefix so they can be searched for inside a hex bytecode string.
 */
const PERMIT_SELECTOR = "d505accf"; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
const NONCES_SELECTOR = "7ecebe00"; // nonces(address)

export async function readPermitSupport(token: Address): Promise<PermitSupport> {
  const target = contractTarget("token");

  let code: string | undefined;
  try {
    code = await withRpcRetry(() => target.client.getCode({ address: token }));
  } catch {
    return null;
  }

  if (typeof code !== "string" || code === "0x" || code === "0x0") return null;

  const lower = code.toLowerCase();
  // Both are required: `permit` without `nonces` cannot produce a replay-safe signature, so a
  // token that only half-implements EIP-2612 is treated as not supporting it.
  return lower.includes(PERMIT_SELECTOR) && lower.includes(NONCES_SELECTOR);
}
