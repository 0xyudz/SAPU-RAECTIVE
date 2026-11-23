import type { DecodedCallError, PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import { TxRevertedError, type ContractCall, type ContractWriter, type Failure, type WriteOptions } from "./ports";

export type BudgetContract = "rsc" | "forwarder";

export interface BudgetSnapshot {
  readonly callbackGasLimit: bigint;
  /** Null when the deployed RSC does not expose the dust floor, or the read failed. */
  readonly minDeposit: bigint | null;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
}

export type BudgetAction =
  | { readonly kind: "set-gas-limit"; readonly gasLimit: bigint }
  | { readonly kind: "set-min-deposit"; readonly minDeposit: bigint }
  | { readonly kind: "cover-debt"; readonly contract: BudgetContract };

export type BudgetPort = ContractWriter;

export type BudgetOutcome =
  | { readonly ok: true; readonly receipt: TxReceipt }
  | (Failure & { readonly receipts: readonly TxReceipt[] });

/**
 * The call and its diff for one operator action.
 *
 * Both owner actions on `SapuRSC` share a shape — read one field, write one field — so they
 * are described together rather than each carrying its own copy of the send pipeline. The
 * `before` values are filled in by `applyBudgetAction` from the live snapshot, which is why
 * the diff here only names the field.
 */
function callFor(action: BudgetAction): { call: ContractCall; field: string; after: string } {
  if (action.kind === "set-gas-limit") {
    return {
      call: {
        contract: "rsc",
        functionName: "setCallbackGasLimit",
        args: [action.gasLimit],
        label: `Set callback gas limit to ${action.gasLimit.toString()}`,
      },
      field: "callbackGasLimit",
      after: action.gasLimit.toString(),
    };
  }

  if (action.kind === "set-min-deposit") {
    return {
      call: {
        contract: "rsc",
        functionName: "setMinDeposit",
        args: [action.minDeposit],
        label: `Set minimum swept deposit to ${action.minDeposit.toString()} base units`,
      },
      field: "minDeposit",
      after: action.minDeposit.toString(),
    };
  }

  return {
    call: {
      contract: action.contract,
      functionName: "coverDebt",
      args: [],
      label: `Settle callback debt on ${action.contract === "rsc" ? "SapuRSC" : "SapuForwarder"}`,
    },
    field: "outstanding debt",
    after: "0",
  };
}

function beforeFor(action: BudgetAction, snapshot: BudgetSnapshot): string {
  if (action.kind === "set-gas-limit") return snapshot.callbackGasLimit.toString();
  if (action.kind === "set-min-deposit") {
    return snapshot.minDeposit === null ? "unavailable" : snapshot.minDeposit.toString();
  }
  return (action.contract === "rsc" ? snapshot.rscDebt : snapshot.forwarderDebt).toString();
}

export async function applyBudgetAction(
  port: BudgetPort,
  action: BudgetAction,
  snapshot: BudgetSnapshot,
  options: WriteOptions = {},
): Promise<BudgetOutcome> {
  if (action.kind === "set-min-deposit" && snapshot.minDeposit === null) {
    // Without a live before-value the preflight diff would be a fabrication. The page also
    // hides the control when the capability is absent, so this is a second line of defence.
    const reason =
      "The current dust floor is unavailable, so this change cannot be shown against a real before-value.";
    options.onEvent?.({ type: "failed", reason });
    return failure(reason);
  }

  const { call, field, after } = callFor(action);

  const diff: PreflightDiff = {
    label: action.kind === "cover-debt"
      ? action.contract === "rsc"
        ? "SapuRSC debt"
        : "SapuForwarder debt"
      : `SapuRSC.${field}`,
    changes: [{ label: field, before: beforeFor(action, snapshot), after }],
  };

  options.onEvent?.({ type: "simulating", label: call.label });
  const simulation = await port.simulateContract(call);

  if (!simulation.ok) {
    const decoded = simulation.kind === "reverted" ? simulation.decoded : undefined;
    options.onEvent?.({ type: "failed", reason: simulation.reason, decoded });
    return failure(simulation.reason, decoded);
  }

  const diffWithGas: PreflightDiff = {
    label: diff.label,
    changes: [
      ...diff.changes,
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
