import type { Address } from "./burner-route";
import { classifyLedger, ledgerLatencyMs, type LedgerLegView, type LedgerRow } from "./ledger";

/**
 * Matching deposits to sweeps, and sweeps to the reactive events that triggered them.
 *
 * This is the part of the ledger that can be wrong in a way nobody notices. A sweep that is
 * matched to the wrong deposit still renders a complete row with plausible numbers; an
 * orphaned deposit that is silently dropped still renders an empty ledger. Neither failure
 * throws, and neither is visible from the chain alone — only from the correlation. So it is a
 * pure function over already decoded events, separate from the indexer and its `eth_getLogs`
 * calls, and the rules below can be pinned directly.
 *
 * ## The matching rules, stated
 *
 * - A sweep claims the **run** of unclaimed deposits at or before its block whose amounts sum
 *   to exactly the swept amount. This is not a heuristic: the forwarder sweeps
 *   `balanceOf(burner)`, so everything that arrived since the previous sweep and has not left
 *   yet is in the burner when the sweep runs. When several deposits were sitting there, the
 *   sweep amount is their sum, and every one of them was swept by that transaction. Claiming
 *   only the single earliest deposit of a matching amount is wrong for exactly that case: a
 *   1.5 SAPU sweep that cleared three 0.5 SAPU deposits would credit one and report the other
 *   two as stalled deposits that are in fact already gone.
 *
 * - If no run sums to the swept amount, a single unclaimed deposit of that exact amount is
 *   claimed. A sweep of one deposit is the common case and stays exact even when earlier
 *   deposits exist that a partial drain already disturbed.
 * - Otherwise the sweep claims the earliest unclaimed deposit at or before its block. A sweep
 *   that moved a clamped or partially-spent balance is still a sweep of *some* deposit, and
 *   reporting it as an orphan would be worse than reporting a mismatched amount.
 * - A sweep with no deposit at all is an orphan. It is kept, because dropping it would make
 *   the ledger understate activity.
 * - A deposit with no sweep is retained and paired with the reactive event that mentions it,
 *   preferring an exact `originBlockNumber` match over any earlier event for the same pair.
 * - An unswept deposit is flagged `dustIgnored` when an unclaimed `DustIgnored` event exists for
 *   the same pair and amount. Each event flags at most one deposit, so a repeated amount does
 *   not make every past deposit look like dust.
 */

/** A token transfer into a burner, as decoded from the origin chain. */
export interface LedgerDeposit {
  readonly burner: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

/** A `PurgeTriggered` (or decoded callback payload), as decoded from the reactive chain. */
export interface LedgerReactive {
  readonly burner: Address;
  readonly token: Address;
  readonly coldWallet: Address | null;
  readonly amount: bigint;
  readonly originBlockNumber: bigint | null;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

/** A `TokensSwept`, as decoded from the origin chain. */
export interface LedgerSweep {
  readonly burner: Address;
  readonly token: Address;
  readonly coldWallet: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

/**
 * A `DustIgnored`, as decoded from the reactive chain.
 *
 * It carries no `originBlockNumber` — the contract emits it from the log it is reacting to and
 * does not copy that field — so it is matched to an unswept deposit by burner, token and
 * amount. That is the same evidence a sweep is matched on, and it is deliberately weaker than
 * an exact origin-block match: the flag says "a deposit of this size was refused as dust", not
 * "this particular deposit was refused as dust".
 */
export interface LedgerDust {
  readonly burner: Address;
  readonly token: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

/** A correlated row before the live-state columns (residue, allowance, cause) are attached. */
/**
 * A correlated row, before the live reads are attached.
 *
 * `liveColdWallet` is excluded because it is not derived from event history at all — it is read
 * from the forwarder at index time. Correlation must not invent it.
 */
export type CorrelatedLedgerRow = Omit<
  LedgerRow,
  "residue" | "allowance" | "cause" | "liveColdWallet"
>;

function pairKey(token: Address, burner: Address): string {
  return `${token}:${burner}`;
}

export function correlateLedger(params: {
  readonly deposits: readonly LedgerDeposit[];
  readonly reactiveEvents: readonly LedgerReactive[];
  readonly sweeps: readonly LedgerSweep[];
  readonly dustEvents: readonly LedgerDust[];
}): CorrelatedLedgerRow[] {
  // "Earliest" in the rules below is a property of the chain, not of the caller's array order.
  // Sorting here makes the matcher correct even if a caller hands events over unsorted.
  const deposits = [...params.deposits].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );

  // Sweeps are sorted too, and this is load-bearing rather than tidy: a sweep only claims the
  // deposits that had *already* arrived when it ran, and it can only claim a deposit once. If an
  // out-of-order array let a later sweep run first, it would consume deposits the earlier sweep
  // had actually cleared, and the earlier one would then be reported as a clamped partial or an
  // orphan. The chain has one true order; this restores it.
  const sweeps = [...params.sweeps].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );

  // Deposits are grouped per pair so a sweep only ever considers its own burner/token.
  const pending = new Map<string, LedgerDeposit[]>();
  for (const deposit of deposits) {
    const key = pairKey(deposit.token, deposit.burner);
    const queue = pending.get(key) ?? [];
    queue.push(deposit);
    pending.set(key, queue);
  }
  const claimed = new Set<LedgerDeposit>();

  // Dust events grouped per pair, then claimed one-to-one so an event documents one deposit.
  const dustByPair = new Map<string, LedgerDust[]>();
  for (const dust of params.dustEvents) {
    const key = pairKey(dust.token, dust.burner);
    const queue = dustByPair.get(key) ?? [];
    queue.push(dust);
    dustByPair.set(key, queue);
  }
  const dustClaimed = new Set<LedgerDust>();

  /**
   * The reactive event that explains a deposit.
   *
   * ## Why this does not compare block numbers
   *
   * `deposit.blockNumber` is an origin-chain height and `event.blockNumber` is a reactive-chain
   * height. They are independent counters: on the live deployment the origin chain is around
   * 63 000 000 and Lasna around 9 000 000. Comparing them is meaningless, and it silently picked
   * the *newest* reactive event for the pair — so a row could display a later deposit's
   * `PurgeTriggered` as its own trigger.
   *
   * The honest link is the decoded payload's `originBlockNumber`, which the RSC itself wrote: it
   * names the exact origin block that caused the callback, i.e. the deposit's block. When several
   * events carry it (a purge and a decoded callback for the same trigger), the first in log order
   * is taken so the row points at the earliest thing that happened.
   */
  const reactiveFor = (deposit: LedgerDeposit): LedgerReactive | null =>
    params.reactiveEvents.find(
      (event) =>
        event.token === deposit.token &&
        event.burner === deposit.burner &&
        event.originBlockNumber !== null &&
        event.originBlockNumber === deposit.blockNumber,
    ) ?? null;

  const rows: CorrelatedLedgerRow[] = [];

  for (const sweep of sweeps) {
    const queue = pending.get(pairKey(sweep.token, sweep.burner)) ?? [];
    const atOrBefore = (deposit: LedgerDeposit) =>
      !claimed.has(deposit) && deposit.blockNumber <= sweep.blockNumber;

    // The candidates the sweep could possibly have moved, oldest first.
    const candidates = queue.filter(atOrBefore);

    // The forwarder sweeps the burner's whole live balance, so a sweep that follows several
    // deposits moves their sum. Reconstructing that run is the only reading under which every
    // deposit is accounted for exactly once.
    //
    // The run must be a *prefix* of the candidates: the burner's balance at sweep time is the
    // sum of everything that had arrived and not yet been swept, so a gap in the middle would
    // mean a deposit was skipped while a later one was not, which the contract cannot do.
    let group: LedgerDeposit[] = [];
    let running = 0n;
    for (const candidate of candidates) {
      running += candidate.amount;
      group.push(candidate);
      if (running === sweep.amount) break;
      if (running > sweep.amount) {
        group = [];
        break;
      }
    }
    if (group.length > 0 && running !== sweep.amount) group = [];

    // Exact single match, for the case where the sweep amount equals one deposit but earlier
    // disturbed deposits sit in front of it. Tried after the prefix so a clean run wins, and
    // only when the prefix did not already explain the amount.
    if (group.length === 0) {
      const exact = candidates.find((candidate) => candidate.amount === sweep.amount);
      if (exact !== undefined) group = [exact];
    }

    // Last resort: a clamped or fee-on-transfer sweep moved less than what was sitting there.
    // It is still a sweep of the earliest deposit, and an orphan row would understate activity.
    const clamped = group.length === 0 ? (candidates[0] ?? null) : null;

    if (group.length === 0 && clamped === null) {
      rows.push({
        id: sweep.leg.txHash,
        burner: sweep.burner,
        token: sweep.token,
        coldWallet: sweep.coldWallet,
        // Null, not "0". An orphan sweep's deposit is outside the scanned window, so its amount
        // was never observed. Encoding that as a real zero rendered "0 SAPU swept 500 SAPU".
        depositAmount: null,
        sweptAmount: sweep.amount.toString(),
        deposit: null,
        reactive: null,
        sweep: sweep.leg,
        status: classifyLedger({ deposit: null, sweep: sweep.leg }),
        latencyMs: null,
        dustIgnored: false,
      });
      continue;
    }

    // One row per deposit the sweep moved. A row's `sweptAmount` is that deposit's own portion,
    // never the whole transaction: summing the column must not count the same token twice.
    for (const deposit of group) {
      claimed.add(deposit);
      const reactive = reactiveFor(deposit);
      rows.push({
        id: deposit.leg.txHash,
        burner: deposit.burner,
        token: deposit.token,
        coldWallet: sweep.coldWallet,
        depositAmount: deposit.amount.toString(),
        sweptAmount: deposit.amount.toString(),
        deposit: deposit.leg,
        reactive: reactive?.leg ?? null,
        sweep: sweep.leg,
        status: classifyLedger({ deposit: deposit.leg, sweep: sweep.leg }),
        latencyMs: ledgerLatencyMs(deposit.leg, sweep.leg),
        dustIgnored: false,
      });
    }

    if (clamped !== null) {
      claimed.add(clamped);
      const reactive = reactiveFor(clamped);
      rows.push({
        id: clamped.leg.txHash,
        burner: clamped.burner,
        token: clamped.token,
        coldWallet: sweep.coldWallet,
        depositAmount: clamped.amount.toString(),
        // The whole sweep amount, because it is the only deposit this row can claim and the
        // difference is exactly what the clamp left behind.
        sweptAmount: sweep.amount.toString(),
        deposit: clamped.leg,
        reactive: reactive?.leg ?? null,
        sweep: sweep.leg,
        status: classifyLedger({ deposit: clamped.leg, sweep: sweep.leg }),
        latencyMs: ledgerLatencyMs(clamped.leg, sweep.leg),
        dustIgnored: false,
      });
    }
  }

  for (const deposit of deposits) {
    if (claimed.has(deposit)) continue;

    const exact =
      params.reactiveEvents.find(
        (event) =>
          event.token === deposit.token &&
          event.burner === deposit.burner &&
          event.originBlockNumber !== null &&
          event.originBlockNumber === deposit.blockNumber,
      ) ?? null;

    // An exact `originBlockNumber` match is positive proof that this deposit triggered a
    // callback, so it outranks a dust event that merely shares the amount. Otherwise a dust
    // event is more specific than a purge event for the same pair, because it matches the
    // amount too, and it is kept as the reactive leg so the refusal is visible in the ledger.
    const dust =
      exact === null
        ? ((dustByPair.get(pairKey(deposit.token, deposit.burner)) ?? []).find(
            (event) => !dustClaimed.has(event) && event.amount === deposit.amount,
          ) ?? null)
        : null;
    if (dust !== null) dustClaimed.add(dust);

    // No loose fallback. Attaching *any* event for the pair, in array order, to a deposit that
    // had no exact match would show an unswept deposit with a newer deposit's reactive
    // transaction as its own trigger — a sequence that never happened. If the decoded payload
    // does not name this deposit's origin block, the honest answer is that no reactive leg is
    // known for it.
    const reactive = exact;

    rows.push({
      id: deposit.leg.txHash,
      burner: deposit.burner,
      token: deposit.token,
      // The caller fills this in from the route when the events did not name it.
      coldWallet: reactive?.coldWallet ?? null,
      depositAmount: deposit.amount.toString(),
      sweptAmount: null,
      deposit: deposit.leg,
      reactive: reactive?.leg ?? dust?.leg ?? null,
      sweep: null,
      status: classifyLedger({ deposit: deposit.leg, sweep: null }),
      latencyMs: null,
      dustIgnored: dust !== null,
    });
  }

  rows.sort((a, b) => {
    const aBlock = BigInt(a.sweep?.blockNumber ?? a.deposit?.blockNumber ?? "0");
    const bBlock = BigInt(b.sweep?.blockNumber ?? b.deposit?.blockNumber ?? "0");
    if (aBlock === bBlock) return a.id.localeCompare(b.id);
    return aBlock < bBlock ? 1 : -1;
  });

  return rows;
}
