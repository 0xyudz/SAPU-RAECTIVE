export type LedgerStatus = "complete" | "reactive-only" | "orphan-sweep";

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

export function ledgerLatencyMs(deposit: LedgerLegView | null, sweep: LedgerLegView | null): number | null {
  if (deposit === null || sweep === null) return null;
  if (deposit.timestamp <= 0 || sweep.timestamp <= 0) return null;
  const delta = sweep.timestamp - deposit.timestamp;
  return delta >= 0 ? delta * 1000 : null;
}
