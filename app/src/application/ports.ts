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

export type Simulation =
  | {
      readonly ok: true;
      readonly prepared: unknown;
      readonly gas: bigint | null;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly decoded?: DecodedCallError;
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
