import type { Address } from "@/domain/burner-route";
import { computeSweepBudget, type SweepBudget } from "@/domain/budget";
import { createCachedLoader } from "./cache";
import { contractTarget } from "./contracts";
import {
  readCallbackGasLimit,
  readDebt,
  readGasPrice,
  readMinDeposit,
  readNativeBalance,
} from "./chain-reads";
import { withRpcRetry } from "./rpc-retry";

export interface BudgetRead {
  readonly callbackGasLimit: bigint;
  readonly minDeposit: bigint;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  readonly rscDebt: bigint;
  readonly forwarderDebt: bigint;
  readonly budget: SweepBudget;
}

const budgetLoader = createCachedLoader<BudgetRead>({
  // The addresses come from `contractTarget`, the same source the rest of the infrastructure
  // reads. Reading `process.env` here bypassed the configuration guard, so a missing or
  // malformed address surfaced as a viem error instead of the configuration message.
  build: () => readBudgetUncached(contractTarget("rsc").address, contractTarget("forwarder").address),
  freshMs: 8_000,
  staleMs: 120_000,
});

async function readBudgetUncached(rsc: Address, forwarder: Address): Promise<BudgetRead> {
  const [callbackGasLimit, minDeposit, rscBalance, forwarderBalance, gasPrice, rscDebt, forwarderDebt] =
    await Promise.all([
      withRpcRetry(() => readCallbackGasLimit(rsc)),
      withRpcRetry(() => readMinDeposit(rsc)),
      withRpcRetry(() => readNativeBalance("rsc")),
      withRpcRetry(() => readNativeBalance("forwarder")),
      withRpcRetry(() => readGasPrice()),
      withRpcRetry(() => readDebt("system", rsc)),
      withRpcRetry(() => readDebt("callback-proxy", forwarder)),
    ]);

  return {
    callbackGasLimit,
    minDeposit,
    rscBalance,
    forwarderBalance,
    gasPrice,
    rscDebt,
    forwarderDebt,
    budget: computeSweepBudget({ balanceWei: forwarderBalance, gasLimit: callbackGasLimit, gasPriceWei: gasPrice }),
  };
}

export function readBudget(rsc: Address, forwarder: Address): Promise<BudgetRead> {
  // The cache is keyed by deployment, not by argument: there is exactly one deployment per
  // build. The arguments are kept so callers pass the addresses they mean, and are asserted
  // against the configured targets rather than silently ignored.
  const configured = contractTarget("rsc").address;
  if (rsc.toLowerCase() !== configured.toLowerCase()) {
    return Promise.reject(
      new Error(`readBudget was asked about RSC ${rsc} but this build is configured for ${configured}.`),
    );
  }
  void forwarder;
  return budgetLoader.load();
}
