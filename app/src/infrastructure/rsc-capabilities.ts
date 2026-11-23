import { toFunctionSelector } from "viem";
import type { Address } from "@/domain/burner-route";
import { contractTarget } from "./contracts";
import { withRpcRetry } from "./rpc-retry";

/**
 * Which optional RSC features the *deployed* contract actually implements.
 *
 * The dust floor (`minDeposit` / `setMinDeposit`) is newer than the first live deployment. An
 * app that read it unconditionally made `/app/budget` fail with a 502 against a perfectly
 * healthy RSC that simply predates the feature. Capabilities are detected from bytecode so a
 * missing function degrades to "not supported" instead of breaking the whole page.
 *
 * `null` means the question could not be answered (bytecode unreadable, or no contract at the
 * address). It is never reported as `false`, so the UI cannot invent a negative.
 */
export interface RscCapabilities {
  /** True when the deployed bytecode dispatches both `minDeposit` and `setMinDeposit`. */
  readonly dustFloor: boolean | null;
}

export const UNKNOWN_RSC_CAPABILITIES: RscCapabilities = { dustFloor: null };

/**
 * Both selectors are required.
 *
 * A read-only `minDeposit` would let the app display a floor it cannot change, and a setter
 * without a getter would let it change a value it cannot show as the `before` side of a
 * preflight diff. Only the pair supports the operator action the UI offers.
 */
const DUST_FLOOR_SELECTORS = [
  toFunctionSelector("minDeposit()").slice(2),
  toFunctionSelector("setMinDeposit(uint256)").slice(2),
];

export async function readRscCapabilities(rsc: Address): Promise<RscCapabilities> {
  const target = contractTarget("rsc");

  let code: string | undefined;
  try {
    code = await withRpcRetry(() => target.client.getCode({ address: rsc }));
  } catch {
    return UNKNOWN_RSC_CAPABILITIES;
  }

  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    return UNKNOWN_RSC_CAPABILITIES;
  }

  const lowered = code.toLowerCase();
  return { dustFloor: DUST_FLOOR_SELECTORS.every((selector) => lowered.includes(selector)) };
}
