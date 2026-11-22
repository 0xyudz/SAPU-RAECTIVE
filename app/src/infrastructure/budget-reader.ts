import type { Address } from "@/domain/burner-route";
import { computeSweepBudget, type SweepBudget } from "@/domain/budget";
import { createCachedLoader } from "./cache";
import { readCallbackGasLimit, readDebt, readGasPrice, readNativeBalance } from "./chain-reads";
import { withRpcRetry } from "./rpc-retry";

export interface BudgetRead {
  readonly callbackGasLimit: bigint;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
  readonly budget: SweepBudget;
}

const budgetLoader = createCachedLoader<BudgetRead>({
  build: async () => {
    const rsc = process.env.NEXT_PUBLIC_SAPU_RSC_ADDRESS as Address;
    const forwarder = process.env.NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS as Address;
    return readBudgetUncached(rsc, forwarder);
  },
  freshMs: 8_000,
  staleMs: 120_000,
});

async function readBudgetUncached(rsc: Address, forwarder: Address): Promise<BudgetRead> {
  const [callbackGasLimit, rscBalance, forwarderBalance, gasPrice, rscDebt, forwarderDebt] =
    await Promise.all([
      withRpcRetry(() => readCallbackGasLimit(rsc)),
      withRpcRetry(() => readNativeBalance("rsc")),
      withRpcRetry(() => readNativeBalance("forwarder")),
      withRpcRetry(() => readGasPrice()),
      withRpcRetry(() => readDebt("system", rsc)),
      withRpcRetry(() => readDebt("callback-proxy", forwarder)),
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

export function readBudget(rsc: Address, forwarder: Address): Promise<BudgetRead> {
  void rsc;
  void forwarder;
  return budgetLoader.load();
}
