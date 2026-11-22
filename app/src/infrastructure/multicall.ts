import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address } from "@/domain/burner-route";
import { contractTarget } from "./contracts";
import { withRpcRetry } from "./rpc-retry";

export function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
const REACTIVE_PARALLEL = 3;

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

export async function multicall(calls: readonly Call3[], chain: "base" | "reactive"): Promise<Array<`0x${string}` | null>> {
  if (calls.length === 0) return [];
  return chain === "base" ? viaMulticall3(calls) : viaEthCall(calls);
}

async function viaMulticall3(calls: readonly Call3[]): Promise<Array<`0x${string}` | null>> {
  const target = contractTarget("forwarder");
  const result = (await withRpcRetry(() =>
    target.client.readContract({
      address: MULTICALL3,
      abi: aggregate3Abi,
      functionName: "aggregate3",
      args: [calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.callData }))],
    }),
  )) as readonly { success: boolean; returnData: `0x${string}` }[];

  return result.map((entry) => (entry.success ? entry.returnData : null));
}

async function viaEthCall(calls: readonly Call3[]): Promise<Array<`0x${string}` | null>> {
  const target = contractTarget("rsc");
  const out: Array<`0x${string}` | null> = new Array(calls.length).fill(null);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(REACTIVE_PARALLEL, calls.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= calls.length) return;
      const call = calls[index]!;
      try {
        const data = await withRpcRetry(() => target.client.call({ to: call.target, data: call.callData }));
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
