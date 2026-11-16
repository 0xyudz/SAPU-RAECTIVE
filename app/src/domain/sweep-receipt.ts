/**
 * Domain: SweepReceipt
 *
 * The three-transaction proof. Every field here is derived from real chain data:
 *
 *   Tx1  deposit        — ERC-20 Transfer(log) on Base Sepolia into the burner
 *   Tx2  reactive       — CallbackRequest on Reactive Lasna, emitted by the system contract
 *   Tx3  sweep          — TokensSwept on Base Sepolia, emitted by SapuForwarder
 *
 * Nothing in this module fabricates a hash or a timestamp. A receipt with a missing
 * leg is represented as an incomplete receipt, never padded with placeholders, so
 * the UI can honestly show "awaiting Tx3" instead of inventing one.
 */

import type { Address, BaseUnits } from "./burner-route";

/** One leg of the loop, as observed on a real chain. */
export interface ChainLeg {
  /** Transaction hash. */
  readonly txHash: `0x${string}`;
  /** Chain the transaction was included on. */
  readonly chainId: number;
  /**
   * Block number.
   *
   * Stored as a decimal string, not a `bigint`, because receipts cross the
   * server/client boundary as JSON and `JSON.stringify` cannot represent `bigint`.
   * Keeping the wire type and the domain type identical avoids a lossy conversion
   * layer — and a decimal string compares and sorts exactly, which a float would not.
   */
  readonly blockNumber: string;
  /** Unix seconds of the block timestamp. */
  readonly timestamp: number;
  /** Explorer URL, built from the chain's explorer base. */
  readonly explorerUrl: string;
}

export type LoopStage = "deposit" | "reactive" | "sweep";

export interface SweepReceipt {
  /** Stable identifier: the deposit transaction hash. */
  readonly id: `0x${string}`;
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly token: Address;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  /** Amount observed on the deposit. */
  readonly depositAmount: BaseUnits;
  /** Amount actually swept. `null` until Tx3 is observed. */
  readonly sweptAmount: BaseUnits | null;
  readonly deposit: ChainLeg;
  /** `null` until the Reactive Omnisystem emits the callback request. */
  readonly reactive: ChainLeg | null;
  /** `null` until the forwarder emits `TokensSwept`. */
  readonly sweep: ChainLeg | null;
}

export class IncompleteReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteReceiptError";
  }
}

/** A receipt is complete only when all three legs have been observed. */
export function isComplete(receipt: SweepReceipt): receipt is SweepReceipt & {
  reactive: ChainLeg;
  sweep: ChainLeg;
  sweptAmount: BaseUnits;
} {
  return receipt.reactive !== null && receipt.sweep !== null && receipt.sweptAmount !== null;
}

/** Which stage the loop has reached. Drives the live watcher terminal. */
export function currentStage(receipt: SweepReceipt): LoopStage {
  if (receipt.sweep) return "sweep";
  if (receipt.reactive) return "reactive";
  return "deposit";
}

/**
 * End-to-end latency, measured from the deposit block to the sweep block.
 *
 * Both timestamps come from chain data, so this is a real measurement rather than a
 * wall-clock estimate. Returns `null` for an incomplete receipt instead of guessing.
 */
export function latencySeconds(receipt: SweepReceipt): number | null {
  if (!isComplete(receipt)) return null;
  return receipt.sweep.timestamp - receipt.deposit.timestamp;
}

/** Attaches the Tx2 leg. Idempotent-safe: refuses to overwrite an existing leg. */
export function withReactiveLeg(receipt: SweepReceipt, leg: ChainLeg): SweepReceipt {
  if (receipt.reactive) {
    throw new IncompleteReceiptError("Reactive leg already recorded.");
  }
  return { ...receipt, reactive: leg };
}

/** Attaches the Tx3 leg and the amount actually moved. */
export function withSweepLeg(receipt: SweepReceipt, leg: ChainLeg, sweptAmount: BaseUnits): SweepReceipt {
  if (receipt.sweep) {
    throw new IncompleteReceiptError("Sweep leg already recorded.");
  }
  return { ...receipt, sweep: leg, sweptAmount };
}

/** Renders base units as a decimal string, without floating point. */
export function formatUnits(value: BaseUnits, decimals: number): string {
  if (!/^\d+$/.test(value)) return "0";
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
