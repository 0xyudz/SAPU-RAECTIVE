import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  decodeErrorResult,
  type Abi,
} from "viem";
import type { DecodedCallError } from "@/domain/tx-receipt";

interface RawDataCarrier {
  data?: unknown;
}

function extractRawData(error: unknown): `0x${string}` | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  if (error instanceof BaseError) {
    const rawError = error.walk((candidate) => candidate instanceof RawContractError) as
      | RawContractError
      | null;
    if (rawError) {
      const data = rawError.data as unknown;
      if (typeof data === "string") return data as `0x${string}`;
      if (typeof data === "object" && data !== null) {
        const nested = (data as RawDataCarrier).data;
        if (typeof nested === "string") return nested as `0x${string}`;
      }
    }

    const revert = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;
    const raw = (revert as unknown as { raw?: unknown })?.raw;
    if (typeof raw === "string") return raw as `0x${string}`;

    const carrier = error.walk((candidate) => {
      const data = (candidate as RawDataCarrier).data;
      return typeof data === "string";
    }) as RawDataCarrier | null;
    if (carrier && typeof carrier.data === "string") return carrier.data as `0x${string}`;
  }

  const direct = (error as RawDataCarrier).data;
  if (typeof direct === "string") return direct as `0x${string}`;
  return undefined;
}

export function decodeRevert(error: unknown, abi: Abi): DecodedCallError {
  let name: string | undefined;
  let args: readonly unknown[] | undefined;

  if (error instanceof BaseError) {
    const revert = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;
    if (revert?.data) {
      name = revert.data.errorName;
      args = revert.data.args as readonly unknown[] | undefined;
    }
  }

  const raw = extractRawData(error) ?? "0x";

  if (raw !== "0x" && (!name || !args)) {
    try {
      const decoded = decodeErrorResult({ abi, data: raw });
      name ??= decoded.errorName;
      args ??= decoded.args as readonly unknown[] | undefined;
    } catch {
    }
  }

  return { name: name ?? "reverted", args, raw };
}

export function describeRevert(decoded: DecodedCallError): string {
  const suffix = decoded.args && decoded.args.length > 0 ? `(${decoded.args.map(String).join(", ")})` : "";
  return `${decoded.name}${suffix}`;
}
