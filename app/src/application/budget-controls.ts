import type { DecodedCallError, PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import { TxRevertedError, type ContractCall, type ContractWriter, type Failure, type WriteOptions } from "./ports";

export type BudgetContract = "rsc" | "forwarder";

export interface BudgetSnapshot {
  readonly callbackGasLimit: bigint;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
}

export type BudgetAction =
  | { readonly kind: "set-gas-limit"; readonly gasLimit: bigint }
  | { readonly kind: "cover-debt"; readonly contract: BudgetContract };

export type BudgetPort = ContractWriter;

export type BudgetOutcome =
  | { readonly ok: true; readonly receipt: TxReceipt }
  | (Failure & { readonly receipts: readonly TxReceipt[] });

function callFor(action: BudgetAction): { call: ContractCall; diff: PreflightDiff } {
  if (action.kind === "set-gas-limit") {
    return {
      call: {
        contract: "rsc",
        functionName: "setCallbackGasLimit",
        args: [action.gasLimit],
        label: `Set callback gas limit to ${action.gasLimit.toString()}`,
      },
      diff: {
        label: "SapuRSC.callbackGasLimit",
        changes: [{ label: "callbackGasLimit", before: "(read from chain)", after: action.gasLimit.toString() }],
      },
    };
  }

  return {
    call: {
      contract: action.contract,
      functionName: "coverDebt",
      args: [],
      label: `Settle callback debt on ${action.contract === "rsc" ? "SapuRSC" : "SapuForwarder"}`,
    },
    diff: {
      label: action.contract === "rsc" ? "SapuRSC debt" : "SapuForwarder debt",
      changes: [{ label: "outstanding debt", before: "(read from chain)", after: "0" }],
    },
  };
}

export async function applyBudgetAction(
  port: BudgetPort,
  action: BudgetAction,
  snapshot: BudgetSnapshot,
  options: WriteOptions = {},
): Promise<BudgetOutcome> {
  const { call, diff } = callFor(action);

  const resolvedDiff: PreflightDiff =
    action.kind === "set-gas-limit"
      ? {
          label: diff.label,
          changes: [
            {
              label: "callbackGasLimit",
              before: snapshot.callbackGasLimit.toString(),
              after: action.gasLimit.toString(),
            },
          ],
        }
      : {
          label: diff.label,
          changes: [
            {
              label: "outstanding debt",
              before: (action.contract === "rsc" ? snapshot.rscDebt : snapshot.forwarderDebt).toString(),
              after: "0",
            },
          ],
        };

  options.onEvent?.({ type: "simulating", label: call.label });
  const simulation = await port.simulateContract(call);

  if (!simulation.ok) {
    options.onEvent?.({ type: "failed", reason: simulation.reason, decoded: simulation.decoded });
    return failure(simulation.reason, simulation.decoded);
  }

  const diffWithGas: PreflightDiff = {
    label: resolvedDiff.label,
    changes: [
      ...resolvedDiff.changes,
      {
        label: "estimated gas",
        before: "—",
        after: simulation.gas !== null ? `${simulation.gas.toString()} gas` : "unavailable",
      },
    ],
  };

  if (options.confirm) {
    const approved = await options.confirm(diffWithGas);
    if (!approved) return failure("Cancelled before sending.");
  }

  options.onEvent?.({ type: "signing", label: call.label });

  let receipt: TxReceipt;
  try {
    receipt = await port.send(simulation.prepared, (hash) =>
      options.onEvent?.({ type: "pending", label: call.label, hash }),
    );
  } catch (error) {
    if (error instanceof TxRevertedError) {
      options.onEvent?.({
        type: "failed",
        reason: error.message,
        decoded: error.decoded,
        receipt: error.receipt,
      });
      return failure(error.message, error.decoded, [error.receipt]);
    }
    const reason = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "failed", reason });
    return failure(reason);
  }

  if (receipt.status === "reverted") {
    const reason = `${call.label} reverted on-chain.`;
    options.onEvent?.({ type: "failed", reason, receipt });
    return failure(reason, undefined, [receipt]);
  }

  options.onEvent?.({ type: "confirmed", receipt });
  return { ok: true, receipt };
}

function failure(
  reason: string,
  decoded?: DecodedCallError,
  receipts: readonly TxReceipt[] = [],
): BudgetOutcome {
  return { ok: false, reason, decoded, receipts };
}
