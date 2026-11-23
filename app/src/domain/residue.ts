import type { BaseUnits } from "./burner-route";
import type { Tone } from "./tone";

/**
 * What is *actually* sitting in the burner right now.
 *
 * The ledger's `status` describes history (did a sweep event exist in the scanned
 * window?). A residue describes the present (is there still value in the burner?).
 * Those are different facts and the operator needs the second one.
 */
export type ResidueState = "cleared" | "held" | "unread";

export const RESIDUE_STATES: readonly ResidueState[] = ["cleared", "held", "unread"];

export const RESIDUE_TONE: Record<ResidueState, Tone> = {
  cleared: "ok",
  held: "danger",
  unread: "muted",
};

export const RESIDUE_NOTE: Record<ResidueState, string> = {
  cleared:
    "balanceOf(burner) is zero right now. The burner is empty, whatever the ledger history says.",
  held:
    "balanceOf(burner) is above zero right now. Tokens are still inside the burner; a sweep event for this deposit either never happened or moved less than the deposit.",
  unread:
    "The balance read failed, so this app does not know. It is not reported as zero, because zero is a claim.",
};

export interface Residue {
  /** Live `balanceOf(burner)` classification. `unread` means the read failed. */
  readonly state: ResidueState;
  /** Live token balance in base units, or null when the read failed. */
  readonly liveBalance: BaseUnits | null;
  /**
   * Deposit minus swept, floored at zero: how much of this row's deposit never
   * left. Null when the live balance could not be read, because a claim about
   * what is stranded is a claim about the present.
   */
  readonly stranded: BaseUnits | null;
}

const UNSET = { state: "unread", liveBalance: null, stranded: null } as const satisfies Residue;

function parseBaseUnits(value: BaseUnits | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/**
 * How much of the observed deposit never left the burner.
 *
 * A row with no sweep event has swept = null, so the whole deposit is stranded.
 * When the sweep moved less than the deposit (the forwarder clamps to the live
 * balance), the difference is reported rather than assumed to be zero.
 */
export function strandedAmount(depositAmount: BaseUnits, sweptAmount: BaseUnits | null): BaseUnits | null {
  const deposit = parseBaseUnits(depositAmount);
  if (deposit === null) return null;
  const swept = sweptAmount === null ? 0n : parseBaseUnits(sweptAmount);
  if (swept === null) return null;
  return deposit > swept ? (deposit - swept).toString() : "0";
}

export function classifyResidue(params: {
  readonly liveBalance: bigint | null;
  readonly depositAmount: BaseUnits;
  readonly sweptAmount: BaseUnits | null;
}): Residue {
  if (params.liveBalance === null) return UNSET;
  return {
    state: params.liveBalance > 0n ? "held" : "cleared",
    liveBalance: params.liveBalance.toString(),
    stranded: strandedAmount(params.depositAmount, params.sweptAmount),
  };
}

/**
 * What the Arm view knows about the selected burner's live balance, as one value.
 *
 * Modelled as a union rather than a set of nullable fields because "no burner", "no token",
 * "still reading", "the read failed" and "the read returned zero" are five different facts.
 * Collapsing them into `balance: string | null` is how a failed read quietly becomes an
 * empty burner in the UI.
 */
export type BurnerBalanceRead =
  | { readonly kind: "no-burner" }
  | { readonly kind: "no-token" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly reason: string }
  /** The endpoint answered, but it could not read `balanceOf`. */
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly balance: BaseUnits };

export interface BurnerBalanceNotice {
  readonly note: string;
  readonly tone: Tone;
}

/**
 * The note beside the burner, plus the tone that colours it.
 *
 * Text and tone are returned together on purpose. Deriving the colour from a substring of
 * the text (the previous approach) means a reword silently repaints the warning, and the
 * type checker cannot catch it. An unread balance is `danger`, never `muted`: it is the
 * state in which the operator most needs to stop and look.
 */
export function burnerBalanceNotice(read: BurnerBalanceRead): BurnerBalanceNotice {
  switch (read.kind) {
    case "no-burner":
      return { note: "no burner selected", tone: "muted" };
    case "no-token":
      return { note: "token not configured yet — burner balance unknown", tone: "muted" };
    case "pending":
      return { note: "reading burner balance…", tone: "muted" };
    case "failed":
      return { note: `burner balance could not be read (${read.reason})`, tone: "danger" };
    case "unread":
      return { note: "burner balance could not be read — treat it as funded", tone: "danger" };
    case "read": {
      const held = parseBaseUnits(read.balance);
      if (held === null) {
        return { note: "burner balance could not be read — treat it as funded", tone: "danger" };
      }
      return held > 0n
        ? { note: `${read.balance} base units still in this burner`, tone: "danger" }
        : { note: "burner is empty", tone: "muted" };
    }
  }
}

export interface ResidueSummary {
  /** Distinct burners whose live balance is above zero. */
  readonly heldBurners: number;
  /** Distinct burners whose live balance could not be read. */
  readonly unreadBurners: number;
  /** Sum of live balances, or null when at least one burner could not be read. */
  readonly totalHeld: BaseUnits | null;
}

/**
 * Aggregate live burner balances for the header of the ledger.
 *
 * Counted per burner, not per row: one burner can appear in several rows (several
 * deposits), but it holds a single balance. Counting rows would multiply the same
 * tokens once per deposit and overstate what is stuck.
 */
export function summarizeResidue(
  rows: readonly { readonly burner: string; readonly residue: Residue }[],
): ResidueSummary {
  const seen = new Map<string, Residue>();
  for (const row of rows) {
    const key = row.burner.toLowerCase();
    if (!seen.has(key)) seen.set(key, row.residue);
  }

  let heldBurners = 0;
  let unreadBurners = 0;
  let total = 0n;

  for (const residue of seen.values()) {
    if (residue.state === "unread") {
      unreadBurners += 1;
      continue;
    }
    if (residue.state === "held") {
      heldBurners += 1;
      total += BigInt(residue.liveBalance ?? "0");
    }
  }

  return {
    heldBurners,
    unreadBurners,
    totalHeld: unreadBurners === 0 ? total.toString() : null,
  };
}
