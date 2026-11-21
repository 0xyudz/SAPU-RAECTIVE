export type RegistryStatus =
  | "agree"
  | "rsc-only"
  | "forwarder-only"
  | "drifted"
  | "revoked";

export interface RegistryTruth {
  readonly rscActive: boolean;
  readonly forwarderArmed: boolean;
  readonly rscColdWallet: string | null;
  readonly forwarderColdWallet: string | null;
}

export type RepairAction = "revoke-rsc" | "disarm-forwarder" | "arm-forwarder" | null;

export interface RegistryDiagnosis {
  readonly status: RegistryStatus;
  readonly tone: "ok" | "warn" | "danger" | "muted";
  readonly summary: string;
  readonly repair: RepairAction;
}

function sameAddress(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

export function diagnoseRoute(truth: RegistryTruth): RegistryDiagnosis {
  const { rscActive, forwarderArmed, rscColdWallet, forwarderColdWallet } = truth;

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

export function needsRepair(status: RegistryStatus): boolean {
  return status === "forwarder-only" || status === "drifted";
}
