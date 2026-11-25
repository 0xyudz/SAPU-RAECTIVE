import type { TxReceipt } from "./tx-receipt";

/**
 * The four steps of arming a route, in execution order.
 *
 * This is the identity and state machine of the pipeline, not a use case: `armRoute` executes
 * these in order and stops at the first it cannot complete, so the order is part of the contract
 * between the pipeline, the authority gate and the UI.
 */
export const ARM_STEP_IDS = ["set-forwarder", "register-route", "arm-rule", "verify"] as const;

export type ArmStepId = (typeof ARM_STEP_IDS)[number];

export type ArmStepStatus = "todo" | "running" | "done" | "skipped" | "failed";

export interface ArmStepState {
  readonly id: ArmStepId;
  readonly status: ArmStepStatus;
  readonly detail: string;
  readonly receipts: readonly TxReceipt[];
}

export function emptyArmSteps(): ArmStepState[] {
  return ARM_STEP_IDS.map((id) => ({ id, status: "todo" as const, detail: "", receipts: [] }));
}
