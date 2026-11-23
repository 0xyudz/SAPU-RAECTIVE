import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  type TransactionReceipt,
} from "viem";
import { TxRevertedError, type ContractCall, type Simulation } from "@/application/ports";
import type { TxReceipt } from "@/domain/tx-receipt";
import type { Address } from "@/domain/burner-route";
import { chainById } from "@/config/chains";
import { contractTarget, type ContractTarget } from "./contracts";
import { decodeRevert, describeRevert } from "./revert";

export interface PreparedSimulation {
  readonly call: ContractCall;
  readonly request: unknown;
}

/**
 * Narrow the opaque `prepared` payload handed back by `simulateCall`.
 *
 * The application layer treats a prepared simulation as opaque, so the writer is the one place
 * that has to prove it really is a `PreparedSimulation` before sending. Kept here rather than
 * in each writer: every writer performs the identical check, and a writer that skipped it
 * would send a request built from an unexpected shape.
 */
export function asPreparedSimulation(value: unknown): PreparedSimulation {
  if (typeof value !== "object" || value === null || !("call" in value)) {
    throw new Error("Invalid prepared simulation.");
  }
  return value as PreparedSimulation;
}

/**
 * Submit one prepared request and wait for its receipt.
 *
 * Shared by the connected-wallet writer and the burner-signed `approve` fallback, so the fee
 * overrides and receipt resolution cannot drift between the two signers. This is the only
 * `writeContract` call site outside `arm-writer`, and both are covered by the audit gate's
 * "no send without a simulation" check.
 */
export async function submitPrepared(
  client: { writeContract: (request: never) => Promise<`0x${string}`>; account?: unknown },
  request: unknown,
  call: ContractCall,
  onPending?: (hash: `0x${string}`) => void,
): Promise<TxReceipt> {
  const target = contractTarget(call.contract);
  const hash = await client.writeContract({
    ...(request as object),
    ...feeOverrides(target.chainId),
    account: client.account,
    chain: null,
  } as never);

  onPending?.(hash);
  const receipt = await target.client.waitForTransactionReceipt({ hash });
  return resolveMinedReceipt(target, call, hash, receipt);
}

export interface FeeOverrides {
  readonly maxPriorityFeePerGas?: bigint;
  readonly maxFeePerGas?: bigint;
}

/**
 * Per-chain gas overrides.
 *
 * Reactive chains price priority at zero, and wallets that insist on a tip get their
 * transaction rejected. Every other chain is left to the wallet's own estimator rather
 * than having a fee guessed for it.
 */
export function feeOverrides(chainId: number): FeeOverrides {
  if (chainById(chainId)?.reactive !== true) return {};
  return { maxPriorityFeePerGas: 1n };
}

export async function simulateCall(call: ContractCall, defaultAccount: Address | null): Promise<Simulation> {
  const from = call.account ?? defaultAccount;

  if (!from) {
    return {
      ok: false,
      kind: "rejected",
      reason: "No account available to simulate from. Connect a wallet first.",
    };
  }

  let target: ContractTarget;
  try {
    target = contractTarget(call.contract);
  } catch (error) {
    return {
      ok: false,
      kind: "rejected",
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
      // Gas estimation is advisory: the simulation already succeeded, so an estimation
      // failure only means the preflight shows no gas figure. It is not a reason to report
      // the call as failed.
      gas = null;
    }

    return {
      ok: true,
      prepared: { call, request: simulated.request } satisfies PreparedSimulation,
      gas,
    };
  } catch (error) {
    return classifySimulationFailure(error, target.abi);
  }
}

/**
 * Separates a real contract revert from everything else.
 *
 * Only a `ContractFunctionRevertedError` proves the call reached the contract and was
 * refused. An unreachable RPC, a rate limit, a timeout or a malformed response proves
 * nothing about chain state, and must not be rendered as "the contract reverted" — the
 * refusal lab publishes these results as evidence, so a flaky node would otherwise be
 * presented as on-chain behaviour.
 */
export function classifySimulationFailure(error: unknown, abi: ContractTarget["abi"]): Simulation {
  const reverted =
    error instanceof BaseError
      ? error.walk((candidate) => candidate instanceof ContractFunctionRevertedError)
      : null;

  if (reverted === null) {
    return {
      ok: false,
      kind: "unreachable",
      reason:
        error instanceof BaseError
          ? (error.shortMessage ?? error.message)
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }

  const decoded = decodeRevert(error, abi);
  return { ok: false, kind: "reverted", reason: describeRevert(decoded), decoded };
}

export function toReceipt(
  hash: `0x${string}`,
  chainId: number,
  receipt: TransactionReceipt,
  label: string,
): TxReceipt {
  const chain = chainById(chainId);
  if (chain === null) {
    throw new Error(`Refusing to build a receipt for chain ${chainId}: it is not a Reactive-supported chain.`);
  }
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
