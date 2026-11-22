export const MAX_UINT256 = (1n << 256n) - 1n;

export const PERMIT_TTL_SECONDS = 3_600;

export const DEFAULT_LEDGER_LOOKBACK = 50_000n;

export const MIN_ALLOWANCE = 1n;

export const POLL_INTERVAL_MS = {
  health: 12_000,
  routes: 12_000,
  ledger: 15_000,
  budget: 15_000,
  refusals: 30_000,
} as const;

export const REFUSAL_PROBES: readonly `0x${string}`[] = [
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
];
