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

/**
 * Storage slots that hold a proxy's implementation address.
 *
 * Reading only the proxy's own bytecode is wrong for a proxied token. Circle's USDC on Base
 * Sepolia is a ZeppelinOS proxy: its runtime code is a ~900-byte forwarder that contains no
 * ERC-20 selectors at all, while `permit`/`nonces` live in the implementation it delegates to.
 * Searching the proxy therefore reported "no EIP-2612" for a token that fully implements it,
 * which pushed the operator to the burner-signed `approve` fallback — the one flow that asks
 * the burner for gas, and one that cannot run at all when the burner is unfunded.
 *
 * EIP-1967 is checked first because it is the standard; the ZeppelinOS slot is included
 * because USDC-style tokens predate it. An unrecognised slot simply reads as zero.
 */
const IMPLEMENTATION_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", // ZeppelinOS
] as const;

const ZERO_WORD = /^0x0{64}$/;

/**
 * The implementation address a proxy delegates to, or `null` when this is not a proxy.
 *
 * A malformed or out-of-range slot value is treated as "not a proxy" rather than as an
 * address: guessing here would search a random contract's bytecode and produce a confident
 * wrong answer.
 */
async function proxyImplementation(
  client: ReturnType<typeof contractTarget>["client"],
  token: Address,
): Promise<Address | null> {
  for (const slot of IMPLEMENTATION_SLOTS) {
    let raw: string | undefined;
    try {
      raw = await withRpcRetry(() => client.getStorageAt({ address: token, slot }));
    } catch {
      // An unreadable slot is not proof of anything; try the next one.
      continue;
    }
    if (typeof raw !== "string" || raw.length !== 66 || ZERO_WORD.test(raw)) continue;
    const candidate = `0x${raw.slice(26)}` as Address;
    // A slot can hold a non-address word (an EIP-1967 beacon slot, a random value). Only treat
    // it as an implementation when there is code there, so the selector search has something
    // real to look at.
    try {
      const code = await withRpcRetry(() => client.getCode({ address: candidate }));
      if (typeof code === "string" && code !== "0x" && code !== "0x0") return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Reads the token's bytecode, following one level of proxy indirection.
 *
 * One level is enough in practice: a proxy delegates to an implementation, and implementations
 * are not themselves proxies. Following further would risk a cycle and buys nothing.
 *
 * `clientFor` exists so the proxy-following logic can be tested without a chain. It is a seam
 * over the *transport*, not over the logic: the selector search, the slot handling and the
 * fallbacks are all the production ones, and the real caller passes nothing.
 */
async function readableBytecode(
  token: Address,
  clientFor: () => ReturnType<typeof contractTarget>["client"] = () =>
    contractTarget("token", token).client,
): Promise<string | null> {
  const client = clientFor();

  let code: string | undefined;
  try {
    code = await withRpcRetry(() => client.getCode({ address: token }));
  } catch {
    return null;
  }
  if (typeof code !== "string" || code === "0x" || code === "0x0") return null;

  const own = code.toLowerCase();
  if (own.includes(PERMIT_SELECTOR) && own.includes(NONCES_SELECTOR)) return own;

  const implementation = await proxyImplementation(client, token);
  if (implementation === null) return own;

  try {
    const implCode = await withRpcRetry(() => client.getCode({ address: implementation }));
    return typeof implCode === "string" ? implCode.toLowerCase() : own;
  } catch {
    return own;
  }
}

export async function readPermitSupport(
  token: Address,
  clientFor?: () => ReturnType<typeof contractTarget>["client"],
): Promise<PermitSupport> {
  const code = await readableBytecode(token, clientFor);
  if (code === null) return null;

  // Both are required: `permit` without `nonces` cannot produce a replay-safe signature, so a
  // token that only half-implements EIP-2612 is treated as not supporting it.
  return code.includes(PERMIT_SELECTOR) && code.includes(NONCES_SELECTOR);
}
