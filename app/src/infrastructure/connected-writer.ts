import type { ContractCall, ContractWriter, Simulation } from "@/application/ports";
import type { TxReceipt } from "@/domain/tx-receipt";
import { chainIdFor, ConfigurationError } from "./contracts";
import { currentAccount, ensureChain, getWalletClient } from "./injected-wallet";
import { simulateCall, asPreparedSimulation, submitPrepared } from "./write-support";

/**
 * The connected-wallet writer every use case shares.
 *
 * ## Why one factory instead of one per use case
 *
 * The budget, lifecycle and rescue writers were byte-for-byte identical apart from the port
 * type they were annotated with. Three copies of `send` means three places where the receipt
 * handling, the chain switch, or the fee override can drift — and a drifted copy would send a
 * transaction that the other paths handle differently, which is exactly the kind of
 * inconsistency that is invisible until it costs gas.
 *
 * The use cases are still separate modules with separate ports; only the transport is shared.
 * `arm-writer` is the exception and stays its own module, because it additionally signs as the
 * burner and holds the permit logic.
 */
export function createConnectedWriter(): ContractWriter {
  return {
    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, currentAccount());
    },

    async send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt> {
      const { call, request } = asPreparedSimulation(prepared);
      const client = getWalletClient();
      if (!client) {
        throw new ConfigurationError("Connect a wallet to sign this transaction.");
      }
      await ensureChain(chainIdFor(call.contract));
      return submitPrepared(client, request, call, onPending);
    },
  };
}
