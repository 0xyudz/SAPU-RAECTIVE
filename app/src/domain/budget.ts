export interface SweepBudget {
  readonly balanceWei: bigint;
  readonly gasLimit: bigint;
  readonly gasPriceWei: bigint;
  /**
   * How many callbacks the balance can pay for, or `null` when it cannot be computed.
   *
   * Null rather than `0` when the cost per sweep is zero: a zero gas limit or gas price means the
   * cost is *unknown*, not free, and `0` is the one value that reads as "the loop is out of
   * budget". The budget page printed `0` in danger red beside a banner saying the runway was
   * unknown — the two claims contradicted each other, and the red one was the fabricated one.
   */
  readonly sweepsRemaining: bigint | null;
  readonly costPerSweepWei: bigint;
}

export function computeSweepBudget(params: {
  balanceWei: bigint;
  gasLimit: bigint;
  gasPriceWei: bigint;
}): SweepBudget {
  const costPerSweepWei = params.gasLimit * params.gasPriceWei;
  const sweepsRemaining =
    costPerSweepWei === 0n ? null : params.balanceWei / costPerSweepWei;
  return {
    balanceWei: params.balanceWei,
    gasLimit: params.gasLimit,
    gasPriceWei: params.gasPriceWei,
    sweepsRemaining,
    costPerSweepWei,
  };
}
