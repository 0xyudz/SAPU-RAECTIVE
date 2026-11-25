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
 * Three surfaces print a token amount with a scale that may be unreadable: the ledger's amount
 * column, the ledger's live-balance cell, and the "still in burners" summary. Each carrying its
 * own `?? 0` / `?? 18` fallback is the bug: `decimals()` returning null is not "decimals are
 * zero", and `formatUnits("1230000", 0)` prints `1230000`, which a reader takes as 1.23 million
 * USDC when it is 1.23 USDC. Substituting 18 is worse — it prints a number off by twelve orders
 * of magnitude.
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
  const scaled = formatUnits(value, decimals);
  // An unparsable value is shown verbatim with the unit named, never as a number. It cannot be
  // scaled because there is nothing to scale, and printing `0` would turn a malformed read into a
  // confident "this position is empty".
  return scaled === null ? `${value} base units ${symbol}` : `${scaled} ${symbol}`;
}

/**
 * Scales base units by `decimals`, or `null` when the inputs cannot be scaled.
 *
 * Returns `null` rather than `"0"` for a non-numeric value: `0` is a real balance and a real
 * claim about the chain, so using it as an error sentinel would report a failed parse as an empty
 * position. The caller decides how to show the raw value; this function only refuses to invent a
 * number.
 *
 * Base units are non-negative integers by construction (ERC-20 `uint256`), so a sign is not
 * handled — the previous implementation had an unreachable `negative` branch that suggested
 * otherwise.
 */
export function formatUnits(value: BaseUnits, decimals: number): string | null {
  if (!/^\d+$/.test(value)) return null;
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const digits = value.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
