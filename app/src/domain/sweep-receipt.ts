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
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
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

export function formatUnits(value: BaseUnits, decimals: number): string {
  if (!/^\d+$/.test(value)) return "0";
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}
