import { describe, expect, it } from "vitest";
import type { Address } from "@/domain/burner-route";
import {
  pairKey,
  probeToken,
  selectRefusalPairs,
  type RefusalCandidate,
} from "@/domain/refusal-pairs";

/**
 * The Refusal Lab is a page whose whole purpose is to be evidence: it shows four calls that must
 * fail, with the decoded reason the chain returned. That makes an incoherent pairing worse than a
 * crash — a crash is visibly broken, while `executeSweep` reverting `RouteNotArmed` on a burner
 * armed only for another asset renders as a tidy green card.
 *
 * The bug these tests pin: the route picked the burner from any row with `forwarderArmed` and took
 * the token from configuration. Armedness lives under `(token, burner)` in the forwarder, so those
 * are not independent facts. On the live deployment the chosen burner happened to be armed for all
 * three tokens and the output was right by luck.
 */

const SAPU = "0x6dec8e5106f1858aa85fd39363eeebd4400c78ad" as Address;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const BURNER_A = "0x40415bd3d8e1b355dd65581bec8eb60f8ed332ad" as Address;
const BURNER_B = "0xf1296614ccf1394bd21a16f991e3d56b7d571121" as Address;
const COLD = "0x5e45df5c1476db6a9e03b7c9e0863faddac49767" as Address;
const FALLBACK = { burner: "0x000000000000000000000000000000000000dead" as Address, coldWallet: "0x000000000000000000000000000000000000dead" as Address };

function row(
  token: Address,
  burner: Address,
  forwarderArmed: boolean,
  coldWallet: Address | null = COLD,
): RefusalCandidate {
  return { token, burner, forwarderArmed, coldWallet };
}

describe("pairKey", () => {
  it("distinguishes the same burner under two tokens", () => {
    // The bug in one line: keying by burner alone makes these the same entry, so a balance read
    // for USDC answers a question asked about SAPU.
    expect(pairKey(SAPU, BURNER_A)).not.toBe(pairKey(USDC, BURNER_A));
  });

  it("is case-insensitive, because addresses arrive from several sources", () => {
    expect(pairKey(SAPU, BURNER_A)).toBe(
      pairKey(SAPU.toUpperCase().replace("0X", "0x") as Address, BURNER_A.toUpperCase().replace("0X", "0x") as Address),
    );
  });
});

describe("probeToken", () => {
  it("probes the token with the most armed routes", () => {
    const rows = [
      row(USDC, BURNER_A, true),
      row(SAPU, BURNER_A, true),
      row(SAPU, BURNER_B, true),
      row(WETH, BURNER_A, true),
    ];
    expect(probeToken(rows, null)).toBe(SAPU);
  });

  it("prefers the configured token when armed counts tie", () => {
    // A tie is not an invitation to pick by array order: the configured token is the deployment's
    // stated subject, so it stays the subject unless the chain says otherwise.
    const rows = [row(USDC, BURNER_A, true), row(SAPU, BURNER_B, true)];
    expect(probeToken(rows, SAPU)).toBe(SAPU);
    expect(probeToken(rows, USDC)).toBe(USDC);
  });

  it("counts only armed rows, so an unarmed route cannot win the probe", () => {
    const rows = [
      row(USDC, BURNER_A, false),
      row(USDC, BURNER_B, false),
      row(SAPU, BURNER_A, true),
    ];
    expect(probeToken(rows, USDC)).toBe(SAPU);
  });

  it("falls back to the configured token when nothing is armed", () => {
    const rows = [row(USDC, BURNER_A, false)];
    expect(probeToken(rows, SAPU)).toBe(SAPU);
  });

  it("falls back to the registry's first token when nothing is armed and nothing is configured", () => {
    const rows = [row(USDC, BURNER_A, false)];
    expect(probeToken(rows, null)).toBe(USDC);
  });

  it("returns the zero address rather than throwing on an empty registry", () => {
    expect(probeToken([], null)).toBe("0x0000000000000000000000000000000000000000");
  });

  it("is deterministic when several tokens tie and none is configured", () => {
    // Two polls of unchanged chain state must not disagree, or the page flickers between
    // subjects and no reading of it can be trusted.
    const rows = [row(WETH, BURNER_A, true), row(USDC, BURNER_B, true)];
    const first = probeToken(rows, null);
    const second = probeToken([...rows].reverse(), null);
    expect(first).toBe(second);
  });
});

describe("selectRefusalPairs", () => {
  it("never pairs a burner with a token it is not armed for", () => {
    // The regression: BURNER_A is armed for WETH only, BURNER_B for SAPU only. Probing SAPU must
    // not select BURNER_A as the zero-balance pair even though its SAPU balance reads zero.
    const rows = [
      row(WETH, BURNER_A, true),
      row(SAPU, BURNER_B, true),
    ];
    const balances = new Map([
      [pairKey(SAPU, BURNER_A), 0n], // a real zero, but for a pair with no rule
      [pairKey(SAPU, BURNER_B), 0n],
    ]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance?.burner).toBe(BURNER_B);
  });

  it("ignores a balance read for another token, even when it is zero", () => {
    // A caller that keys balances by burner alone would hand SAPU's question a USDC answer. The
    // map here contains exactly that mistake; selection must not act on it.
    const rows = [row(SAPU, BURNER_A, true)];
    const balances = new Map([[pairKey(USDC, BURNER_A), 0n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance).toBeNull();
  });

  it("returns null zero-balance when the armed pair holds a balance", () => {
    const rows = [row(SAPU, BURNER_A, true)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), 1_000n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance).toBeNull();
  });

  it("returns null zero-balance when the read failed, because unread is not zero", () => {
    // `NothingToSweep` is a claim about the chain. A failed read cannot support it.
    const rows = [row(SAPU, BURNER_A, true)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), null]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance).toBeNull();
  });

  it("returns null zero-balance when no route for the token is armed", () => {
    const rows = [row(SAPU, BURNER_A, false)];

    const pairs = selectRefusalPairs(rows, SAPU, new Map(), FALLBACK);

    expect(pairs.zeroBalance).toBeNull();
  });

  it("uses a real unarmed row for the disarmed case and says it is not synthetic", () => {
    const rows = [row(SAPU, BURNER_A, true), row(SAPU, BURNER_B, false)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), 0n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.disarmed.burner).toBe(BURNER_B);
    expect(pairs.disarmedIsSynthetic).toBe(false);
  });

  it("marks the disarmed pair synthetic when every route for the token is armed", () => {
    const rows = [row(SAPU, BURNER_A, true)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), 0n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.disarmed).toEqual(FALLBACK);
    expect(pairs.disarmedIsSynthetic).toBe(true);
  });

  it("does not borrow another token's unarmed row for the disarmed case", () => {
    // An unarmed USDC route proves nothing about SAPU: `executeSweep` would revert `RouteNotArmed`
    // for the wrong reason, and the page would credit SAPU's contract with it.
    const rows = [row(SAPU, BURNER_A, true), row(USDC, BURNER_B, false)];

    const pairs = selectRefusalPairs(rows, SAPU, new Map([[pairKey(SAPU, BURNER_A), 0n]]), FALLBACK);

    expect(pairs.disarmedIsSynthetic).toBe(true);
    expect(pairs.disarmed.burner).toBe(FALLBACK.burner);
  });

  it("carries the row's own cold wallet, not a configured one", () => {
    const other = "0x1111111111111111111111111111111111111111" as Address;
    const rows = [row(SAPU, BURNER_A, true, other), row(SAPU, BURNER_B, false, other)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), 0n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance?.coldWallet).toBe(other);
    expect(pairs.disarmed.coldWallet).toBe(other);
  });

  it("falls back for a cold wallet the registry never recorded", () => {
    const rows = [row(SAPU, BURNER_A, true, null)];
    const balances = new Map([[pairKey(SAPU, BURNER_A), 0n]]);

    const pairs = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(pairs.zeroBalance?.coldWallet).toBe(FALLBACK.coldWallet);
  });

  it("is stable across polls: the same state picks the same pair", () => {
    const rows = [
      row(SAPU, BURNER_A, true),
      row(SAPU, BURNER_B, true),
      row(SAPU, FALLBACK.burner, false),
    ];
    const balances = new Map([
      [pairKey(SAPU, BURNER_A), 0n],
      [pairKey(SAPU, BURNER_B), 0n],
    ]);

    const first = selectRefusalPairs(rows, SAPU, balances, FALLBACK);
    const second = selectRefusalPairs(rows, SAPU, balances, FALLBACK);

    expect(second).toEqual(first);
  });
});
