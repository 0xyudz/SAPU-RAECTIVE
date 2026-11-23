import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address } from "@/domain/burner-route";
import { MULTICALL3 } from "@/config/chains";
import { getClient } from "./rpc-clients";
import { withRpcRetry } from "./rpc-retry";

export function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

const PARALLEL_CALLS = 3;

export const aggregate3Abi = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export interface Call3 {
  readonly target: Address;
  readonly callData: `0x${string}`;
}

/**
 * Batches read-only calls against one chain.
 *
 * ## Why this tries Multicall3 and falls back
 *
 * The previous version picked the transport from a chain *label* (`"base"` used
 * Multicall3, `"reactive"` used individual `eth_call`s). That only worked because there
 * were exactly two chains. Reactive supports many origins, and not every one has a
 * Multicall3 deployment, so the transport is now discovered rather than assumed: try the
 * canonical Multicall3, and if it is absent or the call fails, fall back to individual
 * calls. A failed sub-call still reports `null` — never a zero — so a degraded read can
 * never be mistaken for "the balance is 0".
 */
export async function multicall(
  calls: readonly Call3[],
  chainId: number,
): Promise<Array<`0x${string}` | null>> {
  if (calls.length === 0) return [];
  const client = getClient(chainId);

  try {
    const result = (await withRpcRetry(() =>
      client.readContract({
        address: MULTICALL3,
        abi: aggregate3Abi,
        functionName: "aggregate3",
        args: [calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.callData }))],
      }),
    )) as readonly { success: boolean; returnData: `0x${string}` }[];

    return result.map((entry) => (entry.success ? entry.returnData : null));
  } catch {
    // No Multicall3 on this chain, or the batch itself failed. Fall through to
    // per-call reads; the caller still gets one entry per call, `null` on failure.
    return viaEthCall(calls, chainId);
  }
}

async function viaEthCall(
  calls: readonly Call3[],
  chainId: number,
): Promise<Array<`0x${string}` | null>> {
  const client = getClient(chainId);
  const out: Array<`0x${string}` | null> = new Array(calls.length).fill(null);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(PARALLEL_CALLS, calls.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= calls.length) return;
      const call = calls[index]!;
      try {
        const data = await withRpcRetry(() => client.call({ to: call.target, data: call.callData }));
        out[index] = data.data ?? null;
      } catch {
        out[index] = null;
      }
    }
  });

  await Promise.all(workers);
  return out;
}

export function encode(abi: readonly unknown[], functionName: string, args: readonly unknown[]): `0x${string}` {
  return encodeFunctionData({ abi: abi as never, functionName, args: args as never } as never) as `0x${string}`;
}

export function decode<T>(abi: readonly unknown[], functionName: string, data: `0x${string}`): T {
  return decodeFunctionResult({ abi: abi as never, functionName, data } as never) as T;
}
