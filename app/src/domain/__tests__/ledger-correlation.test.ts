import { describe, expect, it } from "vitest";
import {
  correlateLedger,
  type LedgerDeposit,
  type LedgerDust,
  type LedgerReactive,
  type LedgerSweep,
} from "@/domain/ledger-correlation";
import type { LedgerLegView } from "@/domain/ledger";
import type { Address } from "@/domain/burner-route";

/**
 * The correlation is the ledger's only non-obvious logic, and a mistake in it produces a
 * plausible-looking row rather than an error. These tests pin the rules stated in the module
 * comment, so a future edit that quietly reorders the matching fails here instead of on a page.
 *
 * They also stand in for the reason the function was extracted: it can now be tested without a
 * chain, which the version inside `buildIndex` never could.
 */

const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const BURNER: Address = "0x2222222222222222222222222222222222222222";
const OTHER_BURNER: Address = "0x3333333333333333333333333333333333333333";
const COLD: Address = "0x4444444444444444444444444444444444444444";

let txCounter = 0;
function leg(blockNumber: number, timestamp = blockNumber): LedgerLegView {
  txCounter += 1;
  return {
    txHash: `0x${txCounter.toString(16).padStart(64, "0")}`,
    chainId: 84532,
    blockNumber: blockNumber.toString(),
    timestamp,
    explorerUrl: `https://sepolia.basescan.org/tx/${txCounter}`,
  };
}

function deposit(amount: bigint, blockNumber: number, burner: Address = BURNER): LedgerDeposit {
  return { burner, token: TOKEN, amount, blockNumber: BigInt(blockNumber), leg: leg(blockNumber) };
}

function sweep(amount: bigint, blockNumber: number, burner: Address = BURNER): LedgerSweep {
  return {
    burner,
    token: TOKEN,
    coldWallet: COLD,
    amount,
    blockNumber: BigInt(blockNumber),
    leg: leg(blockNumber),
  };
}

function reactive(
  amount: bigint,
  blockNumber: number,
  originBlockNumber: number | null = null,
  burner: Address = BURNER,
): LedgerReactive {
  return {
    burner,
    token: TOKEN,
    coldWallet: COLD,
    amount,
    originBlockNumber: originBlockNumber === null ? null : BigInt(originBlockNumber),
    blockNumber: BigInt(blockNumber),
    leg: leg(blockNumber),
  };
}

function dust(amount: bigint, blockNumber: number, burner: Address = BURNER): LedgerDust {
  return { burner, token: TOKEN, amount, blockNumber: BigInt(blockNumber), leg: leg(blockNumber) };
}

/** Most tests do not involve the dust floor; this keeps them about the sweep correlation. */
function correlate(
  params: Omit<Parameters<typeof correlateLedger>[0], "dustEvents">,
): ReturnType<typeof correlateLedger> {
  return correlateLedger({ ...params, dustEvents: [] });
}

describe("correlateLedger", () => {
  it("pairs a deposit with the sweep that moved the same amount", () => {
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20)],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("complete");
    expect(rows[0]?.depositAmount).toBe("100");
    expect(rows[0]?.sweptAmount).toBe("100");
    expect(rows[0]?.coldWallet).toBe(COLD);
    expect(rows[0]?.latencyMs).toBe(10_000);
  });

  it("matches on amount, not just the first unclaimed deposit", () => {
    // Two deposits into the same burner; the sweep moved the second one's amount. Matching on
    // arrival order would pair it with the first and report the wrong deposit as swept.
    const first = deposit(100n, 10);
    const second = deposit(250n, 11);

    const rows = correlate({
      deposits: [first, second],
      reactiveEvents: [],
      sweeps: [sweep(250n, 20)],
    });

    const complete = rows.find((row) => row.status === "complete");
    expect(complete?.depositAmount).toBe("250");
    expect(complete?.deposit?.txHash).toBe(second.leg.txHash);
  });

  it("falls back to the earliest deposit at or before the sweep when no amount matches", () => {
    // The forwarder sweeps the live balance, which can be clamped by a partial allowance or a
    // fee-on-transfer token. The sweep is still real, so it must claim a deposit rather than
    // become an orphan.
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [],
      sweeps: [sweep(90n, 20)],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("complete");
    expect(rows[0]?.depositAmount).toBe("100");
    expect(rows[0]?.sweptAmount).toBe("90");
  });

  it("never matches a deposit that arrived after the sweep", () => {
    const rows = correlate({
      deposits: [deposit(100n, 30)],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20)],
    });

    const statuses = rows.map((row) => row.status);
    expect(statuses).toContain("orphan-sweep");
    expect(statuses).toContain("reactive-only");
    expect(statuses).not.toContain("complete");
  });

  it("keeps a sweep with no deposit as an orphan instead of dropping it", () => {
    const rows = correlate({
      deposits: [],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20)],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("orphan-sweep");
    expect(rows[0]?.deposit).toBeNull();
    expect(rows[0]?.sweptAmount).toBe("100");
  });

  it("keeps a deposit with no sweep, with the whole amount still unswept", () => {
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [],
      sweeps: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("reactive-only");
    expect(rows[0]?.sweptAmount).toBeNull();
    expect(rows[0]?.coldWallet).toBeNull();
  });

  it("does not let a sweep claim another burner's deposit", () => {
    const rows = correlate({
      deposits: [deposit(100n, 10, OTHER_BURNER)],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20, BURNER)],
    });

    const complete = rows.filter((row) => row.status === "complete");
    expect(complete).toHaveLength(0);
  });

  it("links a sweep to the reactive event that names its origin block", () => {
    // `originBlockNumber` is the RSC's own record of which origin block caused the callback, so it
    // is the only link that is a chain fact. Block *heights* cannot be compared across chains.
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [reactive(100n, 15, 10), reactive(100n, 25, 10)],
      sweeps: [sweep(100n, 20)],
    });

    expect(rows[0]?.reactive?.blockNumber).toBe("15");
  });

  it("does not attach a reactive event whose origin block is a different deposit", () => {
    // The regression: heights were compared across two chains, so a later deposit's
    // `PurgeTriggered` could be shown as this row's trigger. Here the only event for the pair
    // names origin block 99, which is not this deposit, so this row has no reactive leg.
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [reactive(100n, 15, 99)],
      sweeps: [sweep(100n, 20)],
    });

    expect(rows[0]?.reactive).toBeNull();
    expect(rows[0]?.status).toBe("complete");
  });

  it("leaves an unswept deposit without a reactive leg rather than borrowing a later one", () => {
    // The "loose" fallback used to attach any event for the pair, in array order, even one that
    // belonged to a different (and newer) deposit. That rendered a sequence that never happened.
    const rows = correlate({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [reactive(100n, 300, 200)],
      sweeps: [],
    });

    expect(rows[0]?.status).toBe("reactive-only");
    expect(rows[0]?.reactive).toBeNull();
  });

  it("prefers an exact origin-block match for a stranded deposit", () => {
    const stranded = deposit(100n, 10);
    const exact = reactive(100n, 15, 10);
    const loose = reactive(100n, 12, 99);

    const rows = correlate({
      deposits: [stranded],
      reactiveEvents: [loose, exact],
      sweeps: [],
    });

    expect(rows[0]?.reactive?.txHash).toBe(exact.leg.txHash);
  });

  it("orders rows newest first, so the ledger matches the chain", () => {
    const rows = correlate({
      deposits: [deposit(1n, 10), deposit(2n, 30), deposit(3n, 20)],
      reactiveEvents: [],
      sweeps: [],
    });

    const blocks = rows.map((row) => Number(row.deposit?.blockNumber));
    expect(blocks).toEqual([30, 20, 10]);
  });

  it("uses each deposit at most once across several sweeps", () => {
    const only = deposit(100n, 10);
    const rows = correlate({
      deposits: [only],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20), sweep(100n, 25)],
    });

    const complete = rows.filter((row) => row.status === "complete");
    const orphans = rows.filter((row) => row.status === "orphan-sweep");
    expect(complete).toHaveLength(1);
    expect(orphans).toHaveLength(1);
  });

  it("flags an unswept deposit whose amount matches a DustIgnored event", () => {
    const refused = dust(25n, 17);
    const rows = correlateLedger({
      deposits: [deposit(25n, 10)],
      reactiveEvents: [],
      sweeps: [],
      dustEvents: [refused],
    });

    expect(rows[0]?.dustIgnored).toBe(true);
    // The event is kept as the reactive leg so the refusal has a proof next to it.
    expect(rows[0]?.reactive?.txHash).toBe(refused.leg.txHash);
  });

  it("does not flag a deposit that a sweep actually moved", () => {
    // A dust event for the same amount must not mark a deposit the forwarder already swept:
    // that would report a completed row as refused and send the operator to the dust floor.
    const rows = correlateLedger({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [],
      sweeps: [sweep(100n, 20)],
      dustEvents: [dust(100n, 15)],
    });

    expect(rows.filter((row) => row.status === "complete")).toHaveLength(1);
    expect(rows.every((row) => !row.dustIgnored)).toBe(true);
  });

  it("does not flag a deposit that an exact PurgeTriggered event proves reached a callback", () => {
    const rows = correlateLedger({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [reactive(100n, 15, 10)],
      sweeps: [],
      dustEvents: [dust(100n, 15)],
    });

    expect(rows[0]?.dustIgnored).toBe(false);
  });

  it("uses one DustIgnored event for one deposit, so a repeated amount is not all dust", () => {
    const first = deposit(50n, 10);
    const second = deposit(50n, 12);
    const rows = correlateLedger({
      deposits: [first, second],
      reactiveEvents: [],
      sweeps: [],
      dustEvents: [dust(50n, 20)],
    });

    const flagged = rows.filter((row) => row.dustIgnored);
    expect(flagged).toHaveLength(1);
    // The earliest unclaimed deposit is the one the event is matched to, under the same
    // earliest-first rule the sweep matcher uses.
    expect(flagged[0]?.deposit?.txHash).toBe(first.leg.txHash);
  });

  it("leaves a deposit unflagged when no dust event matches its amount", () => {
    const rows = correlateLedger({
      deposits: [deposit(100n, 10)],
      reactiveEvents: [],
      sweeps: [],
      dustEvents: [dust(25n, 17)],
    });

    expect(rows[0]?.dustIgnored).toBe(false);
  });

  describe("a sweep that clears several deposits at once", () => {
    // The forwarder sweeps `balanceOf(burner)`, so every deposit that arrived since the previous
    // sweep is in the burner when it runs. This is the case the ledger got wrong live: three
    // 0.5 deposits were cleared by one 1.5 sweep, and two of them were reported as stalled.

    it("gives every deposit in the run its own complete row", () => {
      const first = deposit(50n, 10);
      const second = deposit(50n, 11);
      const third = deposit(50n, 12);

      const rows = correlate({
        deposits: [first, second, third],
        reactiveEvents: [],
        sweeps: [sweep(150n, 20)],
      });

      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.status === "complete")).toBe(true);
      // Each row is credited with its own portion, so the column does not count 150 three times.
      expect(rows.map((row) => row.sweptAmount)).toEqual(["50", "50", "50"]);
      expect(new Set(rows.map((row) => row.sweep?.txHash)).size).toBe(1);
    });

    it("does not sweep deposits that arrived after the sweep", () => {
      // The prefix must stop at the sweep's block: a later deposit was not in the balance yet.
      const rows = correlate({
        deposits: [deposit(50n, 10), deposit(50n, 30)],
        reactiveEvents: [],
        sweeps: [sweep(50n, 20)],
      });

      const complete = rows.filter((row) => row.status === "complete");
      const stalled = rows.filter((row) => row.status === "reactive-only");
      expect(complete).toHaveLength(1);
      expect(complete[0]?.deposit?.blockNumber).toBe("10");
      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.deposit?.blockNumber).toBe("30");
    });

    it("does not invent a run whose sum overshoots the swept amount", () => {
      // Two deposits sum to more than the sweep moved, so they are not what it cleared. The
      // single exact match is claimed instead of a group that would overstate what happened.
      const rows = correlate({
        deposits: [deposit(100n, 10), deposit(100n, 11)],
        reactiveEvents: [],
        sweeps: [sweep(100n, 20)],
      });

      const complete = rows.filter((row) => row.status === "complete");
      expect(complete).toHaveLength(1);
      expect(complete[0]?.sweptAmount).toBe("100");
      expect(rows.filter((row) => row.status === "reactive-only")).toHaveLength(1);
    });

    it("claims the earlier deposits when a partial drain sits in front of a clean run", () => {
      // A clamped sweep (90 of 100) claims the first deposit; the next sweep moves exactly the
      // second. The exact-single rule must still find it rather than grouping both.
      const rows = correlate({
        deposits: [deposit(100n, 10), deposit(200n, 12)],
        reactiveEvents: [],
        sweeps: [sweep(90n, 20), sweep(200n, 25)],
      });

      const complete = rows.filter((row) => row.status === "complete");
      expect(complete).toHaveLength(2);
      const amounts = complete.map((row) => `${row.depositAmount}/${row.sweptAmount}`).sort();
      expect(amounts).toEqual(["100/90", "200/200"]);
    });

    it("links each deposit in a run to the callback that names its own origin block", () => {
      const first = deposit(50n, 10);
      const second = deposit(50n, 11);
      const rows = correlate({
        deposits: [first, second],
        reactiveEvents: [reactive(50n, 15, 10), reactive(50n, 16, 11)],
        sweeps: [sweep(100n, 20)],
      });

      const byDeposit = new Map(rows.map((row) => [row.deposit?.blockNumber, row.reactive?.blockNumber]));
      expect(byDeposit.get("10")).toBe("15");
      expect(byDeposit.get("11")).toBe("16");
    });

    it("gives the same rows no matter what order the caller supplies", () => {
      // `buildIndex` happens to hand events over oldest-first, but the matcher must not depend on
      // it: a reordered array must not move a deposit from a sweep to its neighbour.
      const deposits = [deposit(50n, 10), deposit(50n, 11), deposit(50n, 12)];
      const sweeps = [sweep(100n, 20), sweep(50n, 25)];

      const forward = correlate({ deposits, reactiveEvents: [], sweeps });
      const reversed = correlate({
        deposits: [...deposits].reverse(),
        reactiveEvents: [],
        sweeps: [...sweeps].reverse(),
      });

      const shape = (rows: typeof forward) =>
        rows
          .map((row) => `${row.deposit?.blockNumber}:${row.status}:${row.sweptAmount}`)
          .sort();
      expect(shape(reversed)).toEqual(shape(forward));
    });
  });
});
