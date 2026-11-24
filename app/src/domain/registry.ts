import type { Tone } from "./tone";

export type RegistryStatus =
  | "agree"
  | "rsc-only"
  | "forwarder-only"
  | "drifted"
  | "revoked"
  /** At least one side could not be read, so no verdict about this pair can be given. */
  | "unreadable";

export interface RegistryTruth {
  /** `null` when the read failed. Not `false`. */
  readonly rscActive: boolean | null;
  readonly forwarderArmed: boolean | null;
  readonly rscColdWallet: string | null;
  readonly forwarderColdWallet: string | null;
}

export type RepairAction = "revoke-rsc" | "disarm-forwarder" | "arm-forwarder" | null;

export interface RegistryDiagnosis {
  readonly status: RegistryStatus;
  readonly tone: Tone;
  readonly summary: string;
  readonly repair: RepairAction;
}

function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

export function diagnoseRoute(truth: RegistryTruth): RegistryDiagnosis {
  const { rscActive, forwarderArmed, rscColdWallet, forwarderColdWallet } = truth;

  // A pair whose state could not be read has no diagnosis. Reporting it as `rsc-only` (the old
  // behaviour) invented a chain fact — "the forwarder has no armed rule" — and offered a repair
  // for a problem that may not exist.
  if (rscActive === null || forwarderArmed === null) {
    return {
      status: "unreadable",
      tone: "warn",
      summary: "At least one side could not be read, so this pair's state is unknown.",
      repair: null,
    };
  }

  if (!rscActive && !forwarderArmed) {
    return {
      status: "revoked",
      tone: "muted",
      summary: "Revoked on both sides.",
      repair: null,
    };
  }

  if (rscActive && !forwarderArmed) {
    return {
      status: "rsc-only",
      tone: "warn",
      summary: "RSC is subscribed but the forwarder has no armed rule. Every callback reverts with RouteNotArmed.",
      repair: "arm-forwarder",
    };
  }

  if (!rscActive && forwarderArmed) {
    return {
      status: "forwarder-only",
      tone: "danger",
      summary: "RSC revoked the route but the forwarder is still armed. Nothing can trigger it; disarm it.",
      repair: "disarm-forwarder",
    };
  }

  if (!sameAddress(rscColdWallet, forwarderColdWallet)) {
    return {
      status: "drifted",
      tone: "danger",
      summary: "Both sides are armed but disagree on the cold wallet. The forwarder will reject the sweep.",
      repair: "disarm-forwarder",
    };
  }

  return {
    status: "agree",
    tone: "ok",
    summary: "Both sides agree on burner, token, and destination.",
    repair: null,
  };
}
