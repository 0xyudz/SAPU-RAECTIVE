import type { ContractCall, Simulation } from "@/application/ports";
import type { BudgetPort } from "@/application/budget-controls";
import type { TxReceipt } from "@/domain/tx-receipt";
import { contractTarget, ConfigurationError } from "./contracts";
import { currentAccount, ensureChain, getWalletClient } from "./injected-wallet";
import { simulateCall, resolveMinedReceipt, type PreparedSimulation } from "./write-support";

function asPrepared(value: unknown): PreparedSimulation {
  if (typeof value !== "object" || value === null || !("call" in value)) {
    throw new Error("Invalid prepared simulation.");
  }
  return value as PreparedSimulation;
}

export function createBudgetWriter(): BudgetPort {
  return {
    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, currentAccount());
    },

    async send(
      prepared: unknown,
      onPending?: (hash: `0x${string}`) => void,
    ): Promise<TxReceipt> {
      const { call, request } = asPrepared(prepared);
      const client = getWalletClient();
      if (!client) {
        throw new ConfigurationError("Connect a wallet to sign this transaction.");
      }
      const target = contractTarget(call.contract);
      await ensureChain(target.chainId);

      const hash = await client.writeContract({
        ...(request as object),
        account: client.account!,
        chain: null,
      } as never);

      onPending?.(hash);
      const receipt = await target.client.waitForTransactionReceipt({ hash });
      return resolveMinedReceipt(target, call, hash, receipt);
    },
  };
}
