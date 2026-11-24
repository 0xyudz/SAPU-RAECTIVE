import type { Address, BaseUnits } from "./burner-route";

export interface ChainLeg {
  readonly txHash: `0x${string}`;
  readonly chainId: number;
  readonly blockNumber: string;
  readonly timestamp: number;
  readonly explorerUrl: string;
}

export interface SweepReceipt {
  readonly id: `0x${string}`;
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly token: Address;
  /**
   * `symbol()` as read from the token contract, or null when it could not be read.
   *
   * Null must never be replaced by the deployment's configured symbol. A receipt for USDC
   * labelled "SAPU" is a confident wrong answer; null says "not read", which is true.
   */
  readonly tokenSymbol: string | null;
  /** `decimals()` as read from the token contract. Null means unreadable, not 18. */
  readonly tokenDecimals: number | null;
  readonly depositAmount: BaseUnits;
  readonly sweptAmount: BaseUnits | null;
  readonly deposit: ChainLeg;
  readonly reactive: ChainLeg | null;
  readonly sweep: ChainLeg | null;
}

export class IncompleteReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteReceiptError";
  }
}

export function withReactiveLeg(receipt: SweepReceipt, leg: ChainLeg): SweepReceipt {
  if (receipt.reactive) {
    throw new IncompleteReceiptError("Reactive leg already recorded.");
  }
  return { ...receipt, reactive: leg };
}

export function withSweepLeg(receipt: SweepReceipt, leg: ChainLeg, sweptAmount: BaseUnits): SweepReceipt {
  if (receipt.sweep) {
    throw new IncompleteReceiptError("Sweep leg already recorded.");
  }
  return { ...receipt, sweep: leg, sweptAmount };
}

/**
 * Renders an amount for a human without ever inventing a scale.
 *
 * ## Why this is one function and not four
 *
 * Three surfaces print a token amount with a scale that may be unreadable: the ledger's amount
 * column, the ledger's live-balance cell, and the "still in burners" summary. Each used to carry
 * its own `?? 0` / `?? 18` fallback. That fallback is the bug: `decimals()` returning null is not
 * "decimals are zero", and `formatUnits("1230000", 0)` prints `1230000`, which a reader takes as
 * 1.23 million USDC when it is 1.23 USDC. Substituting 18 is worse — it prints a number off by
 * twelve orders of magnitude.
 *
 * So null decimals prints the integer *and names it*: `1230000 base units USDC`. The number stays
 * true and the unit is explicit. `0` decimals is a different, legitimate case (a 0-decimal token)
 * and still goes through `formatUnits`.
 *
 * Null `value` means the read failed, which is not zero and not an amount at all, so it renders as
 * an em dash rather than `0 base units`.
 */
export function formatAmount(
  value: BaseUnits | null,
  decimals: number | null,
  symbol: string,
): string {
  if (value === null) return "—";
  if (decimals === null) return `${value} base units ${symbol}`;
  return `${formatUnits(value, decimals)} ${symbol}`;
}

export function formatUnits(value: BaseUnits, decimals: number): string {
  if (!/^\d+$/.test(value)) return "0";
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
