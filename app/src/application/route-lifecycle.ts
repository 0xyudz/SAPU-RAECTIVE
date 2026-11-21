import type { Address } from "@/domain/burner-route";
import type { DecodedCallError, PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import { TxRevertedError, type ContractCall, type ContractWriter, type Failure, type WriteOptions } from "./ports";

export type LifecycleAction = "revoke-rsc" | "disarm-forwarder";

export interface LifecycleInput {
  readonly rsc: Address;
  readonly forwarder: Address;
  readonly burner: Address;
  readonly token: Address;
  readonly action: LifecycleAction;
}

export type LifecyclePort = ContractWriter;

export type LifecycleOutcome =
  | { readonly ok: true; readonly action: LifecycleAction; readonly receipt: TxReceipt }
  | (Failure & { readonly receipts: readonly TxReceipt[] });

function describe(action: LifecycleAction, burner: Address, token: Address): {
  call: ContractCall;
  diff: PreflightDiff;
} {
  if (action === "revoke-rsc") {
    return {
      call: {
        contract: "rsc",
        functionName: "revokeRoute",
        args: [burner, token],
        label: "Revoke the route on SapuRSC",
      },
      diff: {
        label: "SapuRSC.routeOf(token, burner)",
        changes: [
          { label: "route.active", before: "true", after: "false" },
          { label: "route.coldWallet", before: "set", after: "deleted" },
        ],
      },
    };
  }

  return {
    call: {
      contract: "forwarder",
      functionName: "disarmRoute",
      args: [token, burner],
      label: "Disarm the destination rule on SapuForwarder",
    },
    diff: {
      label: "SapuForwarder.ruleOf(token, burner)",
      changes: [
        { label: "rule.armed", before: "true", after: "false" },
        { label: "rule.coldWallet", before: "set", after: "deleted" },
      ],
    },
  };
}

export async function applyRouteRepair(
  port: LifecyclePort,
  input: LifecycleInput,
  options: WriteOptions = {},
): Promise<LifecycleOutcome> {
  const { call, diff } = describe(input.action, input.burner, input.token);

  options.onEvent?.({ type: "simulating", label: call.label });
  const simulation = await port.simulateContract(call);

  if (!simulation.ok) {
    options.onEvent?.({ type: "failed", reason: simulation.reason, decoded: simulation.decoded });
    return failure(simulation.reason, simulation.decoded);
  }

  const preflight: PreflightDiff =
    simulation.gas !== null
      ? {
          label: diff.label,
          changes: [
            ...diff.changes,
            { label: "estimated gas", before: "—", after: `${simulation.gas.toString()} gas` },
          ],
        }
      : diff;

  if (options.confirm) {
    const approved = await options.confirm(preflight);
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
  return { ok: true, action: input.action, receipt };
}

function failure(
  reason: string,
  decoded?: DecodedCallError,
  receipts: readonly TxReceipt[] = [],
): LifecycleOutcome {
  return { ok: false, reason, decoded, receipts };
}
