/**
 * Application: RegistrationService
 *
 * Orchestrates arming a route across the two contracts that must agree on it.
 *
 * The ordering is not arbitrary. `SapuForwarder` immutably stores the RSC address as
 * its authorized callback sender, and `SapuRSC` needs the forwarder address before it
 * can name a recipient. The deployment breaks that cycle; this service breaks the
 * *arming* cycle by requiring both sides to be armed before reporting success.
 *
 * A route is only "armed" when all three conditions hold:
 *   1. RSC knows the forwarder.
 *   2. RSC has a subscription for (token, burner).
 *   3. Forwarder has a matching destination rule.
 *
 * Any partial state is reported as partial, never as success.
 */

import type { Address } from "@/domain/burner-route";
import type { BurnerRoute, RouteRules } from "@/domain/burner-route";
import { createRoute, transition } from "@/domain/burner-route";

export type ArmingStep =
  | "set-forwarder"
  | "register-route"
  | "arm-rule"
  | "verify";

export interface ArmingProgress {
  readonly step: ArmingStep;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly detail?: string;
  readonly txHash?: `0x${string}`;
}

export interface ArmingResult {
  readonly route: BurnerRoute;
  readonly rules: RouteRules;
  readonly progress: readonly ArmingProgress[];
  readonly ok: boolean;
}

/** Port: the chain writes SAPU needs. Implemented by the infrastructure layer. */
export interface RouteRegistrationPort {
  /** Points the RSC at the forwarder. Idempotent on-chain; safe to repeat. */
  setForwarder(params: { rsc: Address; forwarder: Address }): Promise<`0x${string}`>;
  /** Subscribes to deposits into `burner` for `token`. */
  registerRoute(params: { rsc: Address; burner: Address; coldWallet: Address; token: Address }): Promise<`0x${string}`>;
  /** Arms the destination-side rule. */
  armRule(params: { forwarder: Address; burner: Address; coldWallet: Address; token: Address }): Promise<`0x${string}`>;
  /** Reads back both sides to confirm they agree. */
  verify(params: {
    rsc: Address;
    forwarder: Address;
    burner: Address;
    token: Address;
  }): Promise<{ rscArmed: boolean; forwarderArmed: boolean; rscColdWallet: Address | null; forwarderColdWallet: Address | null }>;
}

export interface RegisterInput {
  rsc: Address;
  forwarder: Address;
  burner: string;
  coldWallet: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  chainId: number;
  rules?: Partial<RouteRules>;
}

/**
 * Arms a route end to end.
 *
 * Steps run sequentially and a failure short-circuits: there is no point arming the
 * forwarder if the RSC subscription was rejected, and doing so would leave a rule
 * that can never fire.
 */
export async function registerRoute(port: RouteRegistrationPort, input: RegisterInput): Promise<ArmingResult> {
  // Validate before touching the chain: a bad address should cost nothing.
  const { route: draft, rules } = createRoute(input);

  const progress: ArmingProgress[] = [
    { step: "set-forwarder", status: "pending" },
    { step: "register-route", status: "pending" },
    { step: "arm-rule", status: "pending" },
    { step: "verify", status: "pending" },
  ];

  const setProgress = (step: ArmingStep, update: Partial<ArmingProgress>): void => {
    const index = progress.findIndex((p) => p.step === step);
    if (index >= 0) progress[index] = { ...progress[index]!, ...update };
  };

  try {
    setProgress("set-forwarder", { status: "running" });
    const setForwarderTx = await port.setForwarder({ rsc: input.rsc, forwarder: input.forwarder });
    setProgress("set-forwarder", { status: "done", txHash: setForwarderTx });

    setProgress("register-route", { status: "running" });
    const registerTx = await port.registerRoute({
      rsc: input.rsc,
      burner: draft.burner,
      coldWallet: draft.coldWallet,
      token: draft.token,
    });
    setProgress("register-route", { status: "done", txHash: registerTx });

    setProgress("arm-rule", { status: "running" });
    const armTx = await port.armRule({
      forwarder: input.forwarder,
      burner: draft.burner,
      coldWallet: draft.coldWallet,
      token: draft.token,
    });
    setProgress("arm-rule", { status: "done", txHash: armTx });

    setProgress("verify", { status: "running" });
    const check = await port.verify({
      rsc: input.rsc,
      forwarder: input.forwarder,
      burner: draft.burner,
      token: draft.token,
    });

    const agreed =
      check.rscArmed &&
      check.forwarderArmed &&
      check.rscColdWallet === draft.coldWallet &&
      check.forwarderColdWallet === draft.coldWallet;

    if (!agreed) {
      setProgress("verify", {
        status: "failed",
        detail: describeMismatch(check, draft.coldWallet),
      });
      return { route: draft, rules, progress, ok: false };
    }

    setProgress("verify", { status: "done", detail: "Both sides agree." });

    return {
      route: transition(draft, "armed", Math.floor(Date.now() / 1000)),
      rules,
      progress,
      ok: true,
    };
  } catch (error) {
    const running = progress.find((p) => p.status === "running");
    if (running) {
      setProgress(running.step, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return { route: draft, rules, progress, ok: false };
  }
}

function describeMismatch(
  check: { rscArmed: boolean; forwarderArmed: boolean; rscColdWallet: Address | null; forwarderColdWallet: Address | null },
  expected: Address,
): string {
  if (!check.rscArmed) return "Reactive contract has no subscription for this burner.";
  if (!check.forwarderArmed) return "Forwarder has no armed rule for this burner.";
  if (check.rscColdWallet !== expected) {
    return `Reactive cold wallet is ${check.rscColdWallet}, expected ${expected}.`;
  }
  if (check.forwarderColdWallet !== expected) {
    return `Forwarder cold wallet is ${check.forwarderColdWallet}, expected ${expected}.`;
  }
  return "Both sides armed but destinations disagree.";
}
