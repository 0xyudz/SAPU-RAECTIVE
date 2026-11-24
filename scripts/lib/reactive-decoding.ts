import { decodeAbiParameters, decodeFunctionData, type Abi } from "viem";

/**
 * Decoding for the Reactive callback payload, used by the verification scripts.
 *
 * This mirrors `app/src/infrastructure/reactive-rpc-client.ts`, which cannot be imported here:
 * the app resolves its own modules through the `@/` path alias and the scripts run from the
 * repo root with plain `tsx`. Keeping the decode next to the scripts — instead of pointing
 * one implementation at the other through a path that only works in one process — is the
 * smaller risk. The shape is covered by `app/src/domain/__tests__/infrastructure.test.ts`,
 * so a change to the on-chain encoding fails there first, then here.
 */

/** `executeSweep`, as the RSC asks the forwarder to run it. */
const EXECUTE_SWEEP_ABI = [
  {
    type: "function",
    name: "executeSweep",
    stateMutability: "nonpayable",
    inputs: [
      { name: "reactiveSender_", type: "address" },
      { name: "token_", type: "address" },
      { name: "burner_", type: "address" },
      { name: "coldWallet_", type: "address" },
      { name: "amount_", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export interface DecodedSweepRequest {
  readonly token: `0x${string}`;
  readonly burner: `0x${string}`;
  readonly coldWallet: `0x${string}`;
  readonly amount: bigint;
}

/**
 * The `configuration` field of a real `CallbackRequest` is `abi.encode` of a *struct*, so the
 * bytes begin with a `0x20` offset word. Decoding only the flat layout threw on every live
 * log, which is how the reactive leg went missing from the first proof.
 */
const CONFIGURATION_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "chainId", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "gasLimit", type: "uint64" },
      { name: "payload", type: "bytes" },
    ],
  },
] as const;

const CONFIGURATION_FLAT = [
  { type: "uint256" },
  { type: "address" },
  { type: "uint64" },
  { type: "bytes" },
] as const;

/**
 * Recovers the inner `executeSweep` calldata from `CallbackRequest.configuration`.
 *
 * Returns `"0x"` when neither layout decodes: the input is chain/attacker data, and a
 * malformed payload must read as "no link", never abort the surrounding scan.
 */
export function decodeConfigurationPayload(configuration: `0x${string}`): `0x${string}` {
  try {
    const [tuple] = decodeAbiParameters(CONFIGURATION_TUPLE, configuration) as unknown as [
      { readonly payload?: `0x${string}` },
    ];
    if (typeof tuple?.payload === "string") return tuple.payload;
  } catch {
    // Not struct-wrapped; fall through to the flat layout.
  }

  try {
    const [, , , payload] = decodeAbiParameters(CONFIGURATION_FLAT, configuration) as [
      bigint,
      `0x${string}`,
      bigint,
      `0x${string}`,
    ];
    return payload;
  } catch {
    return "0x";
  }
}

/** The `executeSweep` arguments a callback asks for, or `null` if it is not one. */
export function decodeSweepPayload(payload: `0x${string}`): DecodedSweepRequest | null {
  if (payload === "0x") return null;
  try {
    const decoded = decodeFunctionData({ abi: EXECUTE_SWEEP_ABI, data: payload });
    if (decoded.functionName !== "executeSweep") return null;
    const [, token, burner, coldWallet, amount] = decoded.args as readonly [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      bigint,
    ];
    return {
      token: token.toLowerCase() as `0x${string}`,
      burner: burner.toLowerCase() as `0x${string}`,
      coldWallet: coldWallet.toLowerCase() as `0x${string}`,
      amount,
    };
  } catch {
    return null;
  }
}

export function decodeCallbackRequest(configuration: `0x${string}`): DecodedSweepRequest | null {
  return decodeSweepPayload(decodeConfigurationPayload(configuration));
}
