export interface DecodedCallError {
  readonly name: string;
  readonly args?: readonly unknown[];
  readonly raw: `0x${string}`;
}

export interface PreflightChange {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export interface PreflightDiff {
  readonly label: string;
  readonly changes: readonly PreflightChange[];
}

export type WritePhase =
  | "idle"
  | "simulating"
  | "signing"
  | "pending"
  | "confirmed"
  | "failed";

export interface TxReceipt {
  readonly hash: `0x${string}`;
  readonly chainId: number;
  readonly explorerUrl: string;
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly status: "success" | "reverted";
  readonly label: string;
}

export type WriteOutcome<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: string;
      readonly decoded?: DecodedCallError;
    };

export function formatReceiptUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export function isTerminal(phase: WritePhase): boolean {
  return phase === "confirmed" || phase === "failed";
}
