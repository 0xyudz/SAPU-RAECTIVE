import { encodeFunctionData, type TransactionReceipt } from "viem";
import { TxRevertedError, type ContractCall, type Simulation } from "@/application/ports";
import type { TxReceipt } from "@/domain/tx-receipt";
import type { Address } from "@/domain/burner-route";
import { BASE_SEPOLIA, REACTIVE_LASNA } from "@/config/chains";
import { contractTarget, type ContractTarget } from "./contracts";
import { decodeRevert, describeRevert } from "./revert";

export interface PreparedSimulation {
  readonly call: ContractCall;
  readonly request: unknown;
}

export interface FeeOverrides {
  readonly maxPriorityFeePerGas?: bigint;
  readonly maxFeePerGas?: bigint;
}

export function feeOverrides(chainId: number): FeeOverrides {
  if (chainId !== REACTIVE_LASNA.id) return {};
  return { maxPriorityFeePerGas: 1n };
}

export async function simulateCall(call: ContractCall, defaultAccount: Address | null): Promise<Simulation> {
  const from = call.account ?? defaultAccount;

  if (!from) {
    return {
      ok: false,
      reason: "No account available to simulate from. Connect a wallet first.",
    };
  }

  let target: ContractTarget;
  try {
    target = contractTarget(call.contract);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const simulated = (await target.client.simulateContract({
      address: target.address,
      abi: target.abi,
      functionName: call.functionName,
      args: call.args,
      account: from,
    } as never)) as { request: unknown };

    let gas: bigint | null = null;
    try {
      gas = await target.client.estimateContractGas({
        address: target.address,
        abi: target.abi,
        functionName: call.functionName,
        args: call.args,
        account: from,
      } as never);
    } catch {
      gas = null;
    }

    return {
      ok: true,
      prepared: { call, request: simulated.request } satisfies PreparedSimulation,
      gas,
    };
  } catch (error) {
    const decoded = decodeRevert(error, target.abi);
    return { ok: false, reason: describeRevert(decoded), decoded };
  }
}

export function toReceipt(
  hash: `0x${string}`,
  chainId: number,
  receipt: TransactionReceipt,
  label: string,
): TxReceipt {
  const chain = chainId === REACTIVE_LASNA.id ? REACTIVE_LASNA : BASE_SEPOLIA;
  return {
    hash,
    chainId,
    explorerUrl: chain.txPath(hash),
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    status: receipt.status === "success" ? "success" : "reverted",
    label,
  };
}

export async function resolveMinedReceipt(
  target: ContractTarget,
  call: ContractCall,
  hash: `0x${string}`,
  receipt: TransactionReceipt,
): Promise<TxReceipt> {
  const txReceipt = toReceipt(hash, target.chainId, receipt, call.label);
  if (txReceipt.status === "success") return txReceipt;

  try {
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: call.functionName,
      args: call.args as unknown[],
    });
    await target.client.call({
      to: target.address,
      account: receipt.from,
      data,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    const decoded = decodeRevert(error, target.abi);
    throw new TxRevertedError(txReceipt, describeRevert(decoded), decoded);
  }

  throw new TxRevertedError(txReceipt, "Transaction reverted on-chain.", {
    name: "reverted",
    raw: "0x",
  });
}
