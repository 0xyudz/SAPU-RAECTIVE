import type { Address } from "@/domain/burner-route";
import { createRoute, transition, type BurnerRoute, type RouteRules } from "@/domain/burner-route";
import type { DecodedCallError, PreflightDiff, TxReceipt } from "@/domain/tx-receipt";
import { TxRevertedError, type ContractCall, type ContractWriter, type Failure, type WriteOptions } from "./ports";
import { MAX_UINT256, MIN_ALLOWANCE, PERMIT_TTL_SECONDS } from "@/config/constants";

export type ArmStepId = "set-forwarder" | "register-route" | "arm-rule" | "verify";

export type ArmStepStatus = "todo" | "running" | "done" | "skipped" | "failed";

export interface ArmStepState {
  readonly id: ArmStepId;
  readonly status: ArmStepStatus;
  readonly detail: string;
  readonly receipts: readonly TxReceipt[];
}

export interface PolicyDivergence {
  readonly side: "rsc" | "forwarder";
  readonly expected: Address;
  readonly actual: Address | null;
  readonly detail: string;
}

export interface ArmInspectInput {
  readonly rsc: Address;
  readonly forwarder: Address;
  readonly burner: Address;
  readonly token: Address;
}

export interface ArmingSnapshot {
  readonly forwarder: Address | null;
  readonly routeActive: boolean;
  readonly routeColdWallet: Address | null;
  readonly ruleArmed: boolean;
  readonly ruleColdWallet: Address | null;
  readonly allowance: bigint;
}

export interface PermitSignature {
  readonly v: number;
  readonly r: `0x${string}`;
  readonly s: `0x${string}`;
}

export interface PermitRequest {
  readonly token: Address;
  readonly burner: Address;
  readonly forwarder: Address;
  readonly value: bigint;
  readonly deadline: bigint;
}

export interface RouteRegistrationPort extends ContractWriter {
  inspect(input: ArmInspectInput): Promise<ArmingSnapshot>;
  signPermit?(request: PermitRequest): Promise<PermitSignature | null>;
}

export interface RegisterInput {
  readonly rsc: Address;
  readonly forwarder: Address;
  readonly burner: string;
  readonly coldWallet: string;
  readonly token: string;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly chainId: number;
  readonly rules?: Partial<RouteRules>;
}

export type ArmingOutcome =
  | {
      readonly ok: true;
      readonly route: BurnerRoute;
      readonly rules: RouteRules;
      readonly steps: readonly ArmStepState[];
      readonly receipts: readonly TxReceipt[];
    }
  | (Failure & {
      readonly steps: readonly ArmStepState[];
      readonly receipts: readonly TxReceipt[];
      readonly divergence?: PolicyDivergence;
    });

type StepResult =
  | { readonly kind: "done"; readonly receipt: TxReceipt }
  | { readonly kind: "skipped"; readonly detail: string }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly decoded?: DecodedCallError;
      readonly receipt?: TxReceipt;
    };

function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function short(value: string | null): string {
  return value === null ? "unset" : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

async function execute(
  port: RouteRegistrationPort,
  call: ContractCall,
  diff: PreflightDiff,
  options: WriteOptions,
): Promise<StepResult> {
  options.onEvent?.({ type: "simulating", label: call.label });
  const simulation = await port.simulateContract(call);

  if (!simulation.ok) {
    options.onEvent?.({ type: "failed", reason: simulation.reason, decoded: simulation.decoded });
    return { kind: "failed", reason: simulation.reason, decoded: simulation.decoded };
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
    if (!approved) return { kind: "cancelled" };
  }

  options.onEvent?.({ type: "signing", label: call.label });
  try {
    const receipt = await port.send(simulation.prepared, (hash) =>
      options.onEvent?.({ type: "pending", label: call.label, hash }),
    );
    if (receipt.status === "reverted") {
      const reason = `${call.label} reverted on-chain.`;
      options.onEvent?.({ type: "failed", reason, receipt });
      return { kind: "failed", reason, receipt };
    }
    options.onEvent?.({ type: "confirmed", receipt });
    return { kind: "done", receipt };
  } catch (error) {
    if (error instanceof TxRevertedError) {
      options.onEvent?.({
        type: "failed",
        reason: error.message,
        decoded: error.decoded,
        receipt: error.receipt,
      });
      return { kind: "failed", reason: error.message, decoded: error.decoded, receipt: error.receipt };
    }
    const reason = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "failed", reason });
    return { kind: "failed", reason };
  }
}

function updateStep(
  steps: ArmStepState[],
  id: ArmStepId,
  update: Partial<ArmStepState>,
): void {
  const index = steps.findIndex((step) => step.id === id);
  if (index >= 0) {
    steps[index] = { ...steps[index]!, ...update };
  }
}

export async function armRoute(
  port: RouteRegistrationPort,
  input: RegisterInput,
  options: WriteOptions = {},
): Promise<ArmingOutcome> {
  const { route: draft, rules } = createRoute(input);

  const steps: ArmStepState[] = [
    { id: "set-forwarder", status: "todo", detail: "", receipts: [] },
    { id: "register-route", status: "todo", detail: "", receipts: [] },
    { id: "arm-rule", status: "todo", detail: "", receipts: [] },
    { id: "verify", status: "todo", detail: "", receipts: [] },
  ];
  const receipts: TxReceipt[] = [];

  const fail = (
    reason: string,
    extra: { decoded?: DecodedCallError; divergence?: PolicyDivergence } = {},
  ): ArmingOutcome => {
    const running = steps.find((step) => step.status === "running");
    if (running) {
      updateStep(steps, running.id, { status: "failed", detail: reason });
    }
    return {
      ok: false,
      reason,
      decoded: extra.decoded,
      divergence: extra.divergence,
      steps: [...steps],
      receipts: [...receipts],
    };
  };

  const record = (step: ArmStepId, result: StepResult): StepResult => {
    if (result.kind === "done") {
      receipts.push(result.receipt);
      updateStep(steps, step, {
        status: "done",
        detail: result.receipt.label,
        receipts: [...(steps.find((s) => s.id === step)?.receipts ?? []), result.receipt],
      });
    } else if (result.kind === "failed" && result.receipt) {
      receipts.push(result.receipt);
      updateStep(steps, step, {
        status: "failed",
        detail: result.reason,
        receipts: [...(steps.find((s) => s.id === step)?.receipts ?? []), result.receipt],
      });
    }
    return result;
  };

  const inspectInput: ArmInspectInput = {
    rsc: input.rsc,
    forwarder: input.forwarder,
    burner: draft.burner,
    token: draft.token,
  };

  let snapshot: ArmingSnapshot;
  try {
    snapshot = await port.inspect(inspectInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  updateStep(steps, "set-forwarder", { status: "running" });
  if (sameAddress(snapshot.forwarder, input.forwarder)) {
    updateStep(steps, "set-forwarder", { status: "skipped", detail: "Already points at this forwarder." });
  } else {
    const result = record(
      "set-forwarder",
      await execute(
        port,
        {
          contract: "rsc",
          functionName: "setForwarder",
          args: [input.forwarder],
          label: "Point SapuRSC at the forwarder",
        },
        {
          label: "SapuRSC.sapuForwarder",
          changes: [
            { label: "SapuRSC.sapuForwarder", before: short(snapshot.forwarder), after: input.forwarder },
          ],
        },
        options,
      ),
    );

    if (result.kind === "failed") return fail(result.reason, { decoded: result.decoded });
    if (result.kind === "cancelled") return fail("Cancelled before sending setForwarder.");
  }

  updateStep(steps, "register-route", { status: "running" });
  if (snapshot.routeActive && sameAddress(snapshot.routeColdWallet, draft.coldWallet)) {
    updateStep(steps, "register-route", { status: "skipped", detail: "Already registered with this destination." });
  } else if (snapshot.routeActive) {
    const divergence: PolicyDivergence = {
      side: "rsc",
      expected: draft.coldWallet,
      actual: snapshot.routeColdWallet,
      detail: `SapuRSC has ${short(snapshot.routeColdWallet)} but the signed route expects ${draft.coldWallet}.`,
    };
    updateStep(steps, "register-route", { status: "failed", detail: divergence.detail });
    return fail(divergence.detail, { divergence });
  } else {
    const result = record(
      "register-route",
      await execute(
        port,
        {
          contract: "rsc",
          functionName: "registerRoute",
          args: [draft.burner, draft.coldWallet, draft.token],
          label: "Register the route on SapuRSC",
        },
        {
          label: "SapuRSC.routeOf(token, burner)",
          changes: [
            { label: "route.active", before: String(snapshot.routeActive), after: "true" },
            { label: "route.coldWallet", before: short(snapshot.routeColdWallet), after: draft.coldWallet },
          ],
        },
        options,
      ),
    );

    if (result.kind === "failed") return fail(result.reason, { decoded: result.decoded });
    if (result.kind === "cancelled") return fail("Cancelled before sending registerRoute.");
  }

  updateStep(steps, "arm-rule", { status: "running" });

  const needsAllowance = snapshot.allowance < MIN_ALLOWANCE;
  if (needsAllowance) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_SECONDS);
    let signature: PermitSignature | null = null;
    try {
      signature = port.signPermit
        ? await port.signPermit({
            token: draft.token,
            burner: draft.burner,
            forwarder: input.forwarder,
            value: MAX_UINT256,
            deadline,
          })
        : null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      updateStep(steps, "arm-rule", { status: "failed", detail });
      return fail(detail);
    }

    if (signature === null) {
      const detail =
        "The burner has no allowance to the forwarder and no burner key is available to sign an EIP-2612 permit. Arming now would produce a route whose every sweep reverts.";
      updateStep(steps, "arm-rule", { status: "failed", detail });
      return fail(detail);
    }

    const result = record(
      "arm-rule",
      await execute(
        port,
        {
          contract: "forwarder",
          functionName: "armWithPermit",
          args: [
            draft.token,
            draft.burner,
            MAX_UINT256,
            deadline,
            signature.v,
            signature.r,
            signature.s,
          ],
          label: "Grant the burner allowance with an EIP-2612 permit",
        },
        {
          label: "Token.allowance(burner → forwarder)",
          changes: [
            { label: "allowance", before: snapshot.allowance.toString(), after: "unlimited" },
          ],
        },
        options,
      ),
    );

    if (result.kind === "failed") return fail(result.reason, { decoded: result.decoded });
    if (result.kind === "cancelled") return fail("Cancelled before relaying the permit.");
  }

  const needsRule = !(snapshot.ruleArmed && sameAddress(snapshot.ruleColdWallet, draft.coldWallet));
  if (needsRule) {
    const result = record(
      "arm-rule",
      await execute(
        port,
        {
          contract: "forwarder",
          functionName: "armRoute",
          args: [draft.token, draft.burner, draft.coldWallet],
          label: "Arm the destination rule on SapuForwarder",
        },
        {
          label: "SapuForwarder.ruleOf(token, burner)",
          changes: [
            { label: "rule.armed", before: String(snapshot.ruleArmed), after: "true" },
            { label: "rule.coldWallet", before: short(snapshot.ruleColdWallet), after: draft.coldWallet },
          ],
        },
        options,
      ),
    );

    if (result.kind === "failed") return fail(result.reason, { decoded: result.decoded });
    if (result.kind === "cancelled") return fail("Cancelled before sending armRoute.");
  } else if (!needsAllowance) {
    updateStep(steps, "arm-rule", {
      status: "skipped",
      detail: "Destination rule and burner allowance are already active.",
    });
  }

  updateStep(steps, "verify", { status: "running" });

  let after: ArmingSnapshot;
  try {
    after = await port.inspect(inspectInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const divergence = findDivergence(after, draft.coldWallet);
  if (divergence) {
    updateStep(steps, "verify", { status: "failed", detail: divergence.detail });
    return fail(divergence.detail, { divergence });
  }

  if (after.allowance < MIN_ALLOWANCE) {
    const detail =
      "Both sides are armed but the burner allowance is still zero. The first sweep would revert.";
    updateStep(steps, "verify", { status: "failed", detail });
    return fail(detail);
  }

  updateStep(steps, "verify", { status: "done", detail: "Both sides agree and the burner allowance is non-zero." });

  return {
    ok: true,
    route: transition(draft, "armed", Math.floor(Date.now() / 1000)),
    rules,
    steps: [...steps],
    receipts: [...receipts],
  };
}

export function findDivergence(
  snapshot: ArmingSnapshot,
  expected: Address,
): PolicyDivergence | null {
  if (!snapshot.routeActive) {
    return {
      side: "rsc",
      expected,
      actual: snapshot.routeColdWallet,
      detail: "SapuRSC has no active route for this burner. Expected an armed route.",
    };
  }
  if (!snapshot.ruleArmed) {
    return {
      side: "forwarder",
      expected,
      actual: snapshot.ruleColdWallet,
      detail: "SapuForwarder has no armed rule for this burner. Expected an armed rule.",
    };
  }
  if (!sameAddress(snapshot.routeColdWallet, expected)) {
    return {
      side: "rsc",
      expected,
      actual: snapshot.routeColdWallet,
      detail: `SapuRSC cold wallet is ${short(snapshot.routeColdWallet)}, expected ${expected}.`,
    };
  }
  if (!sameAddress(snapshot.ruleColdWallet, expected)) {
    return {
      side: "forwarder",
      expected,
      actual: snapshot.ruleColdWallet,
      detail: `SapuForwarder cold wallet is ${short(snapshot.ruleColdWallet)}, expected ${expected}.`,
    };
  }
  return null;
}

export function deriveArmSteps(
  snapshot: ArmingSnapshot,
  expected: { readonly forwarder: Address; readonly coldWallet: Address | null },
): readonly ArmStepState[] {
  const forwarderOk = sameAddress(snapshot.forwarder, expected.forwarder);
  const routeOk =
    snapshot.routeActive &&
    (expected.coldWallet === null || sameAddress(snapshot.routeColdWallet, expected.coldWallet));
  const routeDiverged =
    snapshot.routeActive &&
    expected.coldWallet !== null &&
    !sameAddress(snapshot.routeColdWallet, expected.coldWallet);

  const ruleOk =
    snapshot.ruleArmed &&
    (expected.coldWallet === null || sameAddress(snapshot.ruleColdWallet, expected.coldWallet));
  const allowanceOk = snapshot.allowance >= MIN_ALLOWANCE;
  const step3Ok = ruleOk && allowanceOk;
  const verified =
    forwarderOk &&
    routeOk &&
    step3Ok &&
    (expected.coldWallet === null
      ? sameAddress(snapshot.routeColdWallet, snapshot.ruleColdWallet)
      : findDivergence(snapshot, expected.coldWallet) === null);

  return [
    {
      id: "set-forwarder",
      status: forwarderOk ? "skipped" : "todo",
      detail: forwarderOk ? "On-chain SapuRSC.sapuForwarder already matches." : "Needs setForwarder.",
      receipts: [],
    },
    {
      id: "register-route",
      status: routeDiverged ? "failed" : routeOk ? "skipped" : "todo",
      detail: routeDiverged
        ? `SapuRSC has ${short(snapshot.routeColdWallet)} instead of ${expected.coldWallet}.`
        : routeOk
          ? "On-chain SapuRSC.routeOf is active."
          : "Needs registerRoute.",
      receipts: [],
    },
    {
      id: "arm-rule",
      status: step3Ok ? "skipped" : "todo",
      detail: step3Ok
        ? "On-chain forwarder rule and burner allowance are active."
        : !allowanceOk && !ruleOk
          ? "Needs EIP-2612 permit + armRoute."
          : !allowanceOk
            ? "Needs EIP-2612 permit (allowance is 0)."
            : "Needs armRoute on SapuForwarder.",
      receipts: [],
    },
    {
      id: "verify",
      status: verified ? "done" : "todo",
      detail: verified ? "Both sides agree and burner allowance is non-zero." : "Awaiting verification.",
      receipts: [],
    },
  ];
}
