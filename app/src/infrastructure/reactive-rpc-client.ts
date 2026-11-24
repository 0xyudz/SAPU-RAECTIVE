import { parseAbiItem, decodeAbiParameters, decodeFunctionData } from "viem";
import { SYSTEM_CONTRACT } from "@/config/chains";
import { sapuForwarderAbi } from "@/config/abis";
import type { Address } from "@/domain/burner-route";
import { getDecodedLogs } from "./logs";
import { getReactiveClient } from "./rpc-clients";

/** What the RSC actually asked the forwarder to do, recovered from the callback payload. */
export interface DecodedSweepRequest {
  readonly token: Address;
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly amount: bigint;
}

export interface CallbackRequestRecord {
  readonly txHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly chainId: bigint;
  readonly sender: Address;
  readonly recipient: Address;
  readonly payload: `0x${string}`;
  /**
   * The `executeSweep` arguments carried by the payload, or `null` when the payload is not a
   * well-formed `executeSweep`.
   *
   * This is the authoritative link between a callback and the deposit it was raised for: it
   * names the exact token, burner, cold wallet and amount. It is decoded here, in
   * infrastructure, so the application layer can correlate on plain data without importing an
   * ABI. It matters because block *timestamps* on the origin and reactive chains can disagree
   * by a second or two (the live proof callback is timestamped one second *before* the deposit
   * it swept), so ordering alone cannot be trusted to pair them.
   */
  readonly decoded: DecodedSweepRequest | null;
}

export function decodeSweepRequest(payload: `0x${string}`): DecodedSweepRequest | null {
  if (payload === "0x") return null;
  try {
    const decoded = decodeFunctionData({ abi: sapuForwarderAbi, data: payload });
    if (decoded.functionName !== "executeSweep") return null;
    const [, token, burner, coldWallet, amount] = decoded.args as readonly [
      Address,
      Address,
      Address,
      Address,
      bigint,
    ];
    return {
      token: token.toLowerCase() as Address,
      burner: burner.toLowerCase() as Address,
      coldWallet: coldWallet.toLowerCase() as Address,
      amount,
    };
  } catch {
    return null;
  }
}

const callbackRequestEvent = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);

/**
 * The `configuration` field of a real `CallbackRequest`, which is `abi.encode` of a *struct*
 * — hence the leading offset word before the four members.
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

/** The same four members laid out flat, without the struct wrapper. */
const CONFIGURATION_FLAT = [
  { type: "uint256" },
  { type: "address" },
  { type: "uint64" },
  { type: "bytes" },
] as const;

/**
 * Recovers the inner calldata from a `CallbackRequest` log's `data`.
 *
 * ## Why this accepts two layouts
 *
 * The live Reactive node encodes `configuration` as `abi.encode(struct)`, so the bytes begin
 * with a `0x20` offset word that the flat reading does not expect. Decoding only the flat
 * shape threw `Position 400000 is out of bounds` on every real log, the `catch` turned that
 * into `"0x"`, and the caller silently lost the callback — which is how the reactive leg of
 * the live proof went missing. The struct layout is tried first because that is what the
 * chain actually emits; the flat layout is kept as a fallback so a node that emits the bare
 * tuple still decodes.
 *
 * Returning `"0x"` on failure is deliberate: this decodes attacker-controllable log data, and
 * a malformed payload must read as "nothing here", never abort the surrounding scan.
 */
export function decodeCallbackPayload(data: `0x${string}`): `0x${string}` {
  let configuration: `0x${string}`;
  try {
    const [, config] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes" }],
      data,
    ) as [number, `0x${string}`];
    configuration = config;
  } catch {
    return "0x";
  }

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
      Address,
      bigint,
      `0x${string}`,
    ];
    return payload;
  } catch {
    return "0x";
  }
}

export async function findCallbackRequests(params: {
  recipient: Address;
  fromBlock: bigint;
  toBlock?: bigint | "latest";
  lookbackBlocks?: bigint;
}): Promise<CallbackRequestRecord[]> {
  const client = getReactiveClient();
  const toBlock: bigint = params.toBlock && params.toBlock !== "latest"
    ? params.toBlock
    : await client.getBlockNumber();
  const lookback = params.lookbackBlocks ?? 10_000n;

  const resolvedFrom = params.fromBlock > 0n ? params.fromBlock : toBlock > lookback ? toBlock - lookback : 0n;

  // Routed through `logs.ts` so the node's per-request block-range cap is handled by the
  // same chunking/bisect logic the ledger uses. Requesting the whole lookback in one call
  // made this endpoint fail with "getLogs request exceeded max allowed range".
  const logs = await getDecodedLogs<{
    transactionHash: `0x${string}` | null;
    blockNumber: bigint | null;
    logIndex: number | null;
    args: { chainId?: bigint; sender?: string; recipient?: string };
    data: `0x${string}`;
  }>({
    client,
    address: SYSTEM_CONTRACT,
    event: callbackRequestEvent,
    args: { recipient: params.recipient },
    fromBlock: resolvedFrom,
    toBlock,
    cacheKeySuffix: "callback-requests",
  });

  return logs
    .map((log) => {
      const payload = decodeCallbackPayload(log.data);
      return {
        txHash: log.transactionHash!,
        blockNumber: log.blockNumber!,
        logIndex: log.logIndex!,
        chainId: log.args.chainId!,
        sender: (log.args.sender as Address).toLowerCase() as Address,
        recipient: (log.args.recipient as Address).toLowerCase() as Address,
        payload,
        decoded: decodeSweepRequest(payload),
      };
    })
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));
}

export async function reactiveHead(): Promise<bigint> {
  return getReactiveClient().getBlockNumber();
}
