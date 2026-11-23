import type { Address } from "@/domain/burner-route";
import type { DecodedCallError, PreflightDiff, TxReceipt } from "@/domain/tx-receipt";

export type ContractKey = "rsc" | "forwarder" | "token";

export interface ContractCall {
  readonly contract: ContractKey;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly label: string;
  readonly account?: Address;
}

/**
 * The outcome of a preflight simulation.
 *
 * `decoded` is present **only** when the node actually returned revert data from the
 * contract. A transport failure (RPC unreachable, rate limited, timeout) is a separate
 * variant: it says nothing about the chain, and reporting it as a revert would be the app
 * inventing a fact. The refusal lab depends on this distinction — it labels a case
 * `reverted` only when `decoded` exists, so a flaky RPC can no longer be published as
 * "the contract refused this call".
 */
export type Simulation =
  | {
      readonly ok: true;
      readonly prepared: unknown;
      readonly gas: bigint | null;
    }
  | {
      readonly ok: false;
      /** The call reached the contract and it reverted. `decoded` carries the revert data. */
      readonly kind: "reverted";
      readonly reason: string;
      readonly decoded: DecodedCallError;
    }
  | {
      readonly ok: false;
      /** The call never reached the contract. Nothing about chain state is known. */
      readonly kind: "unreachable";
      readonly reason: string;
    }
  | {
      readonly ok: false;
      /** The call was rejected before it was sent (bad config, no account). */
      readonly kind: "rejected";
      readonly reason: string;
    };

export interface ContractWriter {
  simulateContract(call: ContractCall): Promise<Simulation>;
  send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt>;
}

export type WriteProgressEvent =
  | { readonly type: "simulating"; readonly label: string }
  | { readonly type: "signing"; readonly label: string }
  | { readonly type: "pending"; readonly label: string; readonly hash: `0x${string}` }
  | { readonly type: "confirmed"; readonly receipt: TxReceipt }
  | {
      readonly type: "failed";
      readonly reason: string;
      readonly decoded?: DecodedCallError;
      readonly receipt?: TxReceipt;
    };

export type ConfirmGate = (diff: PreflightDiff) => Promise<boolean>;

export interface WriteOptions {
  readonly confirm?: ConfirmGate;
  readonly onEvent?: (event: WriteProgressEvent) => void;
}

export interface Failure {
  readonly ok: false;
  readonly reason: string;
  readonly decoded?: DecodedCallError;
}

export class TxRevertedError extends Error {
  readonly receipt: TxReceipt;
  readonly decoded: DecodedCallError;

  constructor(receipt: TxReceipt, reason: string, decoded: DecodedCallError) {
    super(reason);
    this.name = "TxRevertedError";
    this.receipt = receipt;
    this.decoded = decoded;
  }
}
