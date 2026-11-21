import type { PublicClient } from "viem";
import type { Address } from "@/domain/burner-route";

export interface DecodedLog {
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
  readonly data?: `0x${string}`;
  readonly args: Record<string, unknown>;
}

const CHUNK = 10_000n;

export async function getLogsChunked(params: {
  readonly client: PublicClient;
  readonly address: Address;
  readonly event: unknown;
  readonly args?: Record<string, unknown>;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}): Promise<DecodedLog[]> {
  const out: DecodedLog[] = [];
  let start = params.fromBlock;

  while (start <= params.toBlock) {
    const end = start + CHUNK - 1n > params.toBlock ? params.toBlock : start + CHUNK - 1n;
    const logs = (await params.client.getLogs({
      address: params.address,
      event: params.event,
      args: params.args,
      fromBlock: start,
      toBlock: end,
    } as never)) as unknown as DecodedLog[];
    out.push(...logs);
    start = end + 1n;
  }

  return out;
}
