import type { Address } from "@/domain/burner-route";
import type { Residue } from "@/domain/residue";
import type { PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import { TxRevertedError, type ContractCall, type ContractWriter, type Failure, type WriteOptions } from "./ports";

/**
 * Recovering a residue: tokens already sitting in a burner whose callback never
 * succeeded. This is a distinct use case from arming and from revoking, because it
 * moves value rather than changing policy, so it gets its own port and its own diff.
 */
export interface RescueInput {
  readonly forwarder: Address;
  readonly token: Address;
  readonly burner: Address;
  /**
   * The forwarder rule's *current* cold wallet: `ruleOf(token, burner).coldWallet`.
   *
   * This must come from a live read, never from a historical `TokensSwept` event. `rescueSweep`
   * takes no destination argument — the contract reads `rule.coldWallet` itself — so a value
   * taken from event history would describe a wallet the transaction does not necessarily use.
   * After a re-arm the two diverge, and the operator would approve "send to A" while the chain
   * sends to B.
   */
  readonly coldWallet: Address;
  /** Live balance the rescue would move. */
  readonly residue: Residue;
}

export type RescuePort = ContractWriter;

export type RescueOutcome =
  | { readonly ok: true; readonly receipt: TxReceipt }
  | (Failure & { readonly receipts: readonly TxReceipt[] });

/**
 * Whether a rescue is even meaningful for this row.
 *
 * A rescue of an empty burner reverts with `NothingToSweep`, and a rescue whose
 * balance is unknown would be a blind transaction. Both are reported as reasons
 * instead of being attempted, so the UI never offers an action that cannot work.
 *
 * Takes only the residue because that is the only input the decision depends on;
 * requiring the whole `RescueInput` would force callers to invent the rest.
 */
export function rescueBlockedReason(residue: Residue): string | null {
  if (residue.state === "unread") {
    return "The burner balance could not be read, so there is nothing to confirm this rescue would move.";
  }
  if (residue.state === "cleared") {
    return "The burner is already empty. There is nothing to rescue.";
  }
  return null;
}

function describe(input: RescueInput): { call: ContractCall; diff: PreflightDiff } {
  const live = input.residue.liveBalance ?? "0";
  return {
    call: {
      contract: "forwarder",
      functionName: "rescueSweep",
      args: [input.token, input.burner],
      label: "Rescue the stranded balance to the armed cold wallet",
    },
    diff: {
      label: "SapuForwarder.ruleOf(token, burner)",
      changes: [
        // The destination is not a parameter: it is read from the armed rule inside the
        // contract. Stating that in the diff is the point — the operator is approving "funds go
        // to the wallet this route is armed with", not an address they typed. `input.coldWallet`
        // is that rule's current value, read live; a historical event value would be a claim
        // about a destination the transaction may not use.
        { label: "destination", before: "—", after: `${input.coldWallet} (current armed rule)` },
        { label: "burner balance", before: `${live} base units`, after: "0 base units" },
        { label: "recipient gains", before: "—", after: `${live} base units` },
        { label: "rule.armed", before: "true", after: "true (unchanged)" },
      ],
    },
  };
}

/**
 * Sends a rescue transaction: simulate, show the diff, send, confirm.
 *
 * Returns the receipt in an array so every write use case in this codebase has the
 * same shape, even the ones that only ever produce a single transaction.
 */
export async function rescueResidue(
  port: RescuePort,
  input: RescueInput,
  options: WriteOptions = {},
): Promise<RescueOutcome> {
  const blocked = rescueBlockedReason(input.residue);
  if (blocked !== null) {
    options.onEvent?.({ type: "failed", reason: blocked });
    return { ok: false, reason: blocked, receipts: [] };
  }

  const { call, diff } = describe(input);

  options.onEvent?.({ type: "simulating", label: call.label });
  const simulation = await port.simulateContract(call);

  if (!simulation.ok) {
    const decoded = simulation.kind === "reverted" ? simulation.decoded : undefined;
    options.onEvent?.({ type: "failed", reason: simulation.reason, decoded });
    return { ok: false, reason: simulation.reason, decoded, receipts: [] };
  }

  const preflight: PreflightDiff =
    simulation.gas !== null
      ? {
          label: diff.label,
          changes: [...diff.changes, { label: "estimated gas", before: "—", after: `${simulation.gas.toString()} gas` }],
        }
      : diff;

  if (options.confirm) {
    const approved = await options.confirm(preflight);
    if (!approved) return { ok: false, reason: "Cancelled before sending.", receipts: [] };
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
      return { ok: false, reason: error.message, decoded: error.decoded, receipts: [error.receipt] };
    }
    const reason = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "failed", reason });
    return { ok: false, reason, receipts: [] };
  }

  if (receipt.status === "reverted") {
    const reason = `${call.label} reverted on-chain.`;
    options.onEvent?.({ type: "failed", reason, receipt });
    return { ok: false, reason, receipts: [receipt] };
  }

  options.onEvent?.({ type: "confirmed", receipt });
  return { ok: true, receipt };
}
