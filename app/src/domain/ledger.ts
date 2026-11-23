import type { AllowanceAssessment, StrandRisk } from "./allowance";
import { summarizeStrandRisk } from "./allowance";
import { summarizeResidue, type Residue, type ResidueSummary } from "./residue";
import type { Tone } from "./tone";

export type LedgerStatus = "complete" | "reactive-only" | "orphan-sweep";

export const LEDGER_STATUSES: readonly LedgerStatus[] = ["complete", "reactive-only", "orphan-sweep"];

export const LEDGER_STATUS_TONE: Record<LedgerStatus, Tone> = {
  complete: "ok",
  "reactive-only": "warn",
  "orphan-sweep": "info",
};

export const LEDGER_STATUS_NOTE: Record<LedgerStatus, string> = {
  complete:
    "A deposit and a sweep both exist and the sweep names the same burner/token. The reactive leg is the PurgeTriggered event or the decoded callback payload.",
  "reactive-only":
    "A deposit exists but no sweep does. The loop stalled: the route may be disarmed on one side, the burner allowance may be zero, or the destination budget may be exhausted.",
  "orphan-sweep":
    "A sweep exists but its deposit is outside the scanned window, or the deposit predates this deployment. It is retained because hiding it would make the ledger lie in the other direction.",
};

export interface LedgerLegView {
  readonly txHash: string;
  readonly chainId: number;
  readonly blockNumber: string;
  readonly timestamp: number;
  readonly explorerUrl: string;
}

export interface LedgerRow {
  readonly id: string;
  readonly burner: string;
  readonly token: string;
  readonly coldWallet: string | null;
  readonly depositAmount: string;
  readonly sweptAmount: string | null;
  readonly deposit: LedgerLegView | null;
  readonly reactive: LedgerLegView | null;
  readonly sweep: LedgerLegView | null;
  readonly status: LedgerStatus;
  readonly latencyMs: number | null;
  /** Live balance still sitting in the burner, read at index time. */
  readonly residue: Residue;
  /** Live allowance the burner granted the forwarder, judged against that balance. */
  readonly allowance: AllowanceAssessment;
}

export interface LedgerCounts {
  readonly complete: number;
  readonly reactiveOnly: number;
  readonly orphanSweep: number;
}

export function classifyLedger(row: {
  deposit: LedgerLegView | null;
  sweep: LedgerLegView | null;
}): LedgerStatus {
  if (row.deposit === null && row.sweep !== null) return "orphan-sweep";
  if (row.deposit !== null && row.sweep !== null) return "complete";
  return "reactive-only";
}

export function countLedger(rows: readonly LedgerRow[]): LedgerCounts {
  let complete = 0;
  let reactiveOnly = 0;
  let orphanSweep = 0;
  for (const row of rows) {
    if (row.status === "complete") complete += 1;
    else if (row.status === "reactive-only") reactiveOnly += 1;
    else orphanSweep += 1;
  }
  return { complete, reactiveOnly, orphanSweep };
}

export function residueOf(rows: readonly LedgerRow[]): ResidueSummary {
  return summarizeResidue(rows);
}

export function strandRiskOf(rows: readonly LedgerRow[]): StrandRisk {
  return summarizeStrandRisk(rows);
}

export function ledgerLatencyMs(deposit: LedgerLegView | null, sweep: LedgerLegView | null): number | null {
  if (deposit === null || sweep === null) return null;
  if (deposit.timestamp <= 0 || sweep.timestamp <= 0) return null;
  const delta = sweep.timestamp - deposit.timestamp;
  return delta >= 0 ? delta * 1000 : null;
}
