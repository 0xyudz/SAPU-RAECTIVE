import { parseAbiItem, decodeAbiParameters } from "viem";
import { SYSTEM_CONTRACT } from "@/config/chains";
import type { Address } from "@/domain/burner-route";
import { getReactiveClient } from "./rpc-clients";

export interface CallbackRequestRecord {
  readonly txHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly chainId: bigint;
  readonly sender: Address;
  readonly recipient: Address;
  readonly payload: `0x${string}`;
}

const callbackRequestEvent = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);

export function decodeCallbackPayload(data: `0x${string}`): `0x${string}` {
  try {
    const [, configuration] = decodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes" }],
      data,
    ) as [number, `0x${string}`];

    const [, , , payload] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "bytes" }],
      configuration,
    ) as [bigint, Address, bigint, `0x${string}`];

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

  const logs = await client.getLogs({
    address: SYSTEM_CONTRACT,
    event: callbackRequestEvent,
    args: { recipient: params.recipient },
    fromBlock: resolvedFrom,
    toBlock,
  });

  return logs
    .map((log) => ({
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
      logIndex: log.logIndex!,
      chainId: log.args.chainId!,
      sender: (log.args.sender as Address).toLowerCase() as Address,
      recipient: (log.args.recipient as Address).toLowerCase() as Address,
      payload: decodeCallbackPayload(log.data),
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));
}

export async function reactiveHead(): Promise<bigint> {
  return getReactiveClient().getBlockNumber();
}
