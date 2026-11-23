import type { ContractCall, Simulation } from "@/application/ports";
import type { RescuePort } from "@/application/rescue-service";
import type { TxReceipt } from "@/domain/tx-receipt";
import { contractTarget, ConfigurationError } from "./contracts";
import { currentAccount, ensureChain, getWalletClient } from "./injected-wallet";
import { simulateCall, resolveMinedReceipt, feeOverrides, type PreparedSimulation } from "./write-support";

function asPrepared(value: unknown): PreparedSimulation {
  if (typeof value !== "object" || value === null || !("call" in value)) {
    throw new Error("Invalid prepared simulation.");
  }
  return value as PreparedSimulation;
}

/**
 * Writer for the rescue use case.
 *
 * Same protocol as every other writer in this codebase — simulate, then send, then
 * wait for the receipt — but bound to the `RescuePort` so the application layer never
 * reaches into viem or the wallet directly.
 */
export function createRescueWriter(): RescuePort {
  return {
    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, currentAccount());
    },

    async send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt> {
      const { call, request } = asPrepared(prepared);
      const client = getWalletClient();
      if (!client) {
        throw new ConfigurationError("Connect a wallet to sign this transaction.");
      }
      const target = contractTarget(call.contract);
      await ensureChain(target.chainId);

      const hash = await client.writeContract({
        ...(request as object),
        ...feeOverrides(target.chainId),
        account: client.account!,
        chain: null,
      } as never);

      onPending?.(hash);
      const receipt = await target.client.waitForTransactionReceipt({ hash });
      return resolveMinedReceipt(target, call, hash, receipt);
    },
  };
}
