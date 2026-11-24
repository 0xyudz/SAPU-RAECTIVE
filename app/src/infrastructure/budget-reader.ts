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
import { readRscCapabilities } from "./rsc-capabilities";
import { withRpcRetry } from "./rpc-retry";

export interface BudgetRead {
  readonly callbackGasLimit: bigint;
  /**
   * The on-chain dust floor, or `null` when the deployed RSC does not expose it or the read
   * failed. It is nullable because the feature postdates the first live deployment; treating
   * "not implemented" as a fatal read made the entire budget page unavailable.
   */
  readonly minDeposit: bigint | null;
  /** Whether the deployed bytecode implements the dust floor. `null` when unreadable. */
  readonly dustFloorSupported: boolean | null;
  readonly rscBalance: bigint;
  readonly forwarderBalance: bigint;
  readonly gasPrice: bigint;
  /** Outstanding debt, or `null` when the read failed. Null is not "no debt". */
  readonly rscDebt: bigint | null;
  readonly forwarderDebt: bigint | null;
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
  const [capabilities, callbackGasLimit, rscBalance, forwarderBalance, gasPrice, rscDebt, forwarderDebt] =
    await Promise.all([
      readRscCapabilities(rsc),
      withRpcRetry(() => readCallbackGasLimit(rsc)),
      withRpcRetry(() => readNativeBalance("rsc")),
      withRpcRetry(() => readNativeBalance("forwarder")),
      withRpcRetry(() => readGasPrice()),
      // Not wrapped in `withRpcRetry`: `readDebt` retries internally, because its own catch is
      // what turns a transport failure into `null` — an outer retry would only ever see `null`.
      readDebt("system", rsc),
      readDebt("callback-proxy", forwarder),
    ]);

  // When the bytecode proves the function is absent, calling it would revert every time and
  // take the whole budget read down with it. When support is unknown, the read is still
  // attempted: an unreadable capability must not hide a value the node can return.
  const minDeposit =
    capabilities.dustFloor === false
      ? null
      : await withRpcRetry(() => readMinDeposit(rsc)).catch(() => null);

  return {
    callbackGasLimit,
    minDeposit,
    dustFloorSupported: capabilities.dustFloor,
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
