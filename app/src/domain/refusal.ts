import type { Address } from "./burner-route";
import type { Tone } from "./tone";

export const REFUSAL_CASE_IDS = [
  "non-owner-register",
  "non-provider-sweep",
  "disarmed-route",
  "zero-balance",
] as const;

export type RefusalCaseId = (typeof REFUSAL_CASE_IDS)[number];

export type RefusalOutcome = "reverted" | "unexpected-success" | "error";

export const REFUSAL_OUTCOME_TONE: Record<RefusalOutcome, Tone> = {
  reverted: "ok",
  "unexpected-success": "danger",
  error: "warn",
};

export interface RefusalCaseResult {
  readonly id: RefusalCaseId;
  readonly title: string;
  readonly call: string;
  readonly executedFrom: Address;
  readonly expectedError: string;
  readonly outcome: RefusalOutcome;
  readonly raw: `0x${string}`;
  readonly decodedName: string | null;
  readonly decodedArgs: readonly string[];
  readonly explanation: string;
  readonly detail?: string;
}

export function allCasesReverted(cases: readonly RefusalCaseResult[]): boolean {
  return cases.length === REFUSAL_CASE_IDS.length && cases.every((item) => item.outcome === "reverted");
}

export function revertedCount(cases: readonly RefusalCaseResult[]): number {
  return cases.filter((item) => item.outcome === "reverted").length;
}
