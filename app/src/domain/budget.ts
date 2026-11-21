export interface SweepBudget {
  readonly balanceWei: bigint;
  readonly gasLimit: bigint;
  readonly gasPriceWei: bigint;
  readonly sweepsRemaining: bigint;
  readonly costPerSweepWei: bigint;
}

export function computeSweepBudget(params: {
  balanceWei: bigint;
  gasLimit: bigint;
  gasPriceWei: bigint;
}): SweepBudget {
  const costPerSweepWei = params.gasLimit * params.gasPriceWei;
  const sweepsRemaining =
    costPerSweepWei === 0n ? 0n : params.balanceWei / costPerSweepWei;
  return {
    balanceWei: params.balanceWei,
    gasLimit: params.gasLimit,
    gasPriceWei: params.gasPriceWei,
    sweepsRemaining,
    costPerSweepWei,
  };
}

export function isInDebt(debtWei: bigint): boolean {
  return debtWei > 0n;
}
