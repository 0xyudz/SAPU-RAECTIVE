import { describe, expect, it } from "vitest";
import {
  armableTokenMetadata,
  normaliseTokenDecimals,
  normaliseTokenSymbol,
  tokenMetadataIsArmable,
  tokenMetadataNotice,
  type TokenMetadataRead,
} from "@/domain/token-metadata";

/**
 * These tests pin the rule that made the Arm page lie: metadata must describe the token in the
 * form, and an unread token must block arming rather than inherit some other token's scale.
 */
describe("normaliseTokenSymbol", () => {
  it("accepts an ordinary symbol", () => {
    expect(normaliseTokenSymbol("USDC")).toBe("USDC");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseTokenSymbol("  DAI \n")).toBe("DAI");
  });

  it("rejects an empty or whitespace-only symbol", () => {
    expect(normaliseTokenSymbol("")).toBeNull();
    expect(normaliseTokenSymbol("   ")).toBeNull();
  });

  it("rejects non-strings, because a symbol is a claim about a string return", () => {
    expect(normaliseTokenSymbol(18)).toBeNull();
    expect(normaliseTokenSymbol(18n)).toBeNull();
    expect(normaliseTokenSymbol(null)).toBeNull();
    expect(normaliseTokenSymbol(undefined)).toBeNull();
    expect(normaliseTokenSymbol({ symbol: "SAPU" })).toBeNull();
  });

  it("rejects a symbol carrying control characters", () => {
    expect(normaliseTokenSymbol("SA\u0000PU")).toBeNull();
    expect(normaliseTokenSymbol("SA\u007fPU")).toBeNull();
    expect(normaliseTokenSymbol("line\nbreak")).toBeNull();
  });

  it("truncates rather than rendering an absurdly long answer", () => {
    const long = "A".repeat(200);
    expect(normaliseTokenSymbol(long)).toHaveLength(32);
  });
});

describe("normaliseTokenDecimals", () => {
  it("accepts a bigint, which is what a uint8 read returns", () => {
    expect(normaliseTokenDecimals(18n)).toBe(18);
    expect(normaliseTokenDecimals(6n)).toBe(6);
    expect(normaliseTokenDecimals(0n)).toBe(0);
  });

  it("accepts a plain number", () => {
    expect(normaliseTokenDecimals(8)).toBe(8);
  });

  it("rejects values outside the range the route record accepts", () => {
    expect(normaliseTokenDecimals(-1n)).toBeNull();
    expect(normaliseTokenDecimals(37n)).toBeNull();
    expect(normaliseTokenDecimals(1_000_000n)).toBeNull();
  });

  it("rejects a non-integer", () => {
    expect(normaliseTokenDecimals(1.5)).toBeNull();
  });

  it("rejects anything that is not a number at all", () => {
    expect(normaliseTokenDecimals("18")).toBeNull();
    expect(normaliseTokenDecimals(null)).toBeNull();
    expect(normaliseTokenDecimals(undefined)).toBeNull();
  });
});

describe("tokenMetadataNotice", () => {
  const origin = "Base Sepolia";

  it("names the token that was actually read, with its own scale and chain", () => {
    expect(
      tokenMetadataNotice({ kind: "read", symbol: "USDC", decimals: 6 }, origin),
    ).toEqual({ note: "USDC · 6 decimals · Base Sepolia", tone: "muted" });
  });

  it("says a readable token is informational, never a warning", () => {
    expect(
      tokenMetadataNotice({ kind: "read", symbol: "SAPU", decimals: 18 }, origin).tone,
    ).toBe("muted");
  });

  it("blocks arming when nothing has been typed yet", () => {
    const notice = tokenMetadataNotice({ kind: "no-token" }, origin);
    expect(notice.tone).toBe("muted");
    expect(notice.note).toContain("no token address");
  });

  it("reports an in-flight read as in-flight, not as a failure", () => {
    const notice = tokenMetadataNotice({ kind: "pending" }, origin);
    expect(notice.tone).toBe("muted");
    expect(notice.note).toContain("reading");
  });

  it("treats a transport failure as danger and says the read failed", () => {
    const notice = tokenMetadataNotice({ kind: "failed", reason: "429 Too Many Requests" }, origin);
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("could not be read");
    expect(notice.note).toContain("429 Too Many Requests");
    expect(notice.note).toContain("arm is blocked");
  });

  it("treats a missing contract as danger and does not blame the RPC", () => {
    const notice = tokenMetadataNotice({ kind: "no-code" }, origin);
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("no contract at this address");
    expect(notice.note).toContain("arm is blocked");
    expect(notice.note).not.toContain("could not be read");
  });

  it("treats a non-ERC-20 answer as danger and carries the reason", () => {
    const notice = tokenMetadataNotice(
      { kind: "unread", reason: "decimals() did not answer as an ERC-20 uint8" },
      origin,
    );
    expect(notice.tone).toBe("danger");
    expect(notice.note).toContain("decimals()");
    expect(notice.note).toContain("arm is blocked");
  });

  it("never prints the origin name for a token it could not read", () => {
    for (const read of [
      { kind: "no-token" },
      { kind: "pending" },
      { kind: "failed", reason: "timeout" },
      { kind: "no-code" },
      { kind: "unread", reason: "symbol() reverted" },
    ] satisfies TokenMetadataRead[]) {
      expect(tokenMetadataNotice(read, origin).note).not.toContain(origin);
    }
  });
});

describe("tokenMetadataIsArmable", () => {
  it("arms only on a completed read", () => {
    expect(tokenMetadataIsArmable({ kind: "read", symbol: "USDC", decimals: 6 })).toBe(true);
  });

  it("blocks every state where the token's scale is unknown", () => {
    const blocked: TokenMetadataRead[] = [
      { kind: "no-token" },
      { kind: "pending" },
      { kind: "failed", reason: "timeout" },
      { kind: "no-code" },
      { kind: "unread", reason: "symbol() reverted" },
    ];
    for (const read of blocked) {
      expect(tokenMetadataIsArmable(read)).toBe(false);
    }
  });
});

describe("armableTokenMetadata", () => {
  it("returns the pair the route record must carry", () => {
    expect(armableTokenMetadata({ kind: "read", symbol: "USDC", decimals: 6 })).toEqual({
      symbol: "USDC",
      decimals: 6,
    });
  });

  it("returns null instead of a placeholder when the token was not read", () => {
    expect(armableTokenMetadata({ kind: "no-token" })).toBeNull();
    expect(armableTokenMetadata({ kind: "pending" })).toBeNull();
    expect(armableTokenMetadata({ kind: "failed", reason: "timeout" })).toBeNull();
    expect(armableTokenMetadata({ kind: "no-code" })).toBeNull();
    expect(armableTokenMetadata({ kind: "unread", reason: "reverted" })).toBeNull();
  });

  it("cannot silently reuse another token's scale", () => {
    // The bug this guards: a route recorded as SAPU/18 for a 6-decimal token. Nothing here
    // accepts a fallback, so the caller has no way to substitute one.
    const read: TokenMetadataRead = { kind: "read", symbol: "USDC", decimals: 6 };
    expect(armableTokenMetadata(read)).toEqual({ symbol: "USDC", decimals: 6 });
    expect(armableTokenMetadata(read)?.symbol).not.toBe("SAPU");
    expect(armableTokenMetadata(read)?.decimals).not.toBe(18);
  });
});
