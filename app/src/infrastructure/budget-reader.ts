import type { Address } from "@/domain/burner-route";
import { computeSweepBudget, type SweepBudget } from "@/domain/budget";
import { readCallbackGasLimit, readDebt, readGasPrice, readNativeBalance } from "./chain-reads";

export interface BudgetRead {
  readonly callbackGasLimit: bigint;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
  readonly budget: SweepBudget;
}

export async function readBudget(rsc: Address, forwarder: Address): Promise<BudgetRead> {
  const [callbackGasLimit, rscBalance, forwarderBalance, gasPrice, rscDebt, forwarderDebt] =
    await Promise.all([
      readCallbackGasLimit(rsc),
      readNativeBalance("rsc"),
      readNativeBalance("forwarder"),
      readGasPrice(),
      readDebt("system", rsc),
      readDebt("callback-proxy", forwarder),
    ]);

  return {
    callbackGasLimit,
    rscBalance,
    forwarderBalance,
    gasPrice,
    rscDebt,
    forwarderDebt,
    budget: computeSweepBudget({ balanceWei: forwarderBalance, gasLimit: callbackGasLimit, gasPriceWei: gasPrice }),
  };
}
