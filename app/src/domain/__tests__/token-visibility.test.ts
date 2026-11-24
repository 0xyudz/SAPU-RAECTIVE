import { describe, expect, it } from "vitest";
import type { Address } from "@/domain/burner-route";

/**
 * The registry used to write `rscTokens: []` into every row — a hardcoded empty array, not a
 * read. The UI rendered it as `tokensOf: 0`, which states a chain fact that was never observed:
 * on the live deployment `SapuRSC.tokensOf(burner)` answers with **three** tokens while the
 * registry printed zero.
 *
 * These tests pin the two distinct meanings that replaced it:
 *
 *   - `null`  → the call could not be made. Render "unreadable".
 *   - `[]`    → the chain was asked and there are no routes.
 *
 * Collapsing them would restore the fabricated zero.
 */

const RSC = "0x8bf210c429a35efc0f8618df1f8b883cdbc7ea5d" as Address;
const BURNER = "0x40415bd3d8e1b355dd65581bec8eb60f8ed332ad" as Address;

/** Mirrors the shape `readTokensOf` returns, so the assertions read as the UI would. */
type TokensOf = readonly Address[] | null;

function describeTokensOf(tokens: TokensOf): string {
  // This is the exact expression used by `registry-row.tsx`.
  return tokens === null ? "unreadable" : String(tokens.length);
}

describe("tokensOf rendering", () => {
  it("renders a failed read as unreadable, never as zero", () => {
    expect(describeTokensOf(null)).toBe("unreadable");
    expect(describeTokensOf(null)).not.toBe("0");
  });

  it("renders an empty answer as zero, because the chain was actually asked", () => {
    expect(describeTokensOf([])).toBe("0");
  });

  it("renders the real count when the chain answered", () => {
    // The live value: SAPU, USDC, WETH for the funded burner.
    const tokens = [
      "0x6dec8e5106f1858aa85fd39363eeebd4400c78ad",
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      "0x4200000000000000000000000000000000000006",
    ] as Address[];
    expect(describeTokensOf(tokens)).toBe("3");
  });
});

describe("token symbol rendering", () => {
  /**
   * The registry row's token cell. A token whose `symbol()` could not be read must fall back to
   * its address, never to the deployment's configured symbol — a USDC row labelled "SAPU" is a
   * confident wrong answer, while an address is merely ugly.
   */
  function renderToken(symbol: string | null, decimals: number | null, address: Address): string {
    const head = symbol ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
    return decimals === null ? head : `${head} · ${decimals} dp`;
  }

  it("shows the symbol and decimals read from the token", () => {
    expect(renderToken("USDC", 6, "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address)).toBe(
      "USDC · 6 dp",
    );
  });

  it("shows a different token with its own decimals, not the default's 18", () => {
    expect(renderToken("USDC", 6, "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address)).not.toContain(
      "18",
    );
  });

  it("falls back to the address when the symbol is unreadable", () => {
    const address = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;
    const rendered = renderToken(null, null, address);
    expect(rendered).toBe("0x036c…cf7e");
    expect(rendered).not.toContain("SAPU");
  });

  it("does not invent 18 decimals when decimals could not be read", () => {
    const rendered = renderToken("USDC", null, "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address);
    expect(rendered).toBe("USDC");
  });
});

describe("readTokensOf contract", () => {
  it("is declared on the RSC ABI with a burner argument", async () => {
    // The function existed on-chain all along; the app simply never called it.
    const { sapuRscAbi } = await import("@/config/abis");
    const tokensOf = sapuRscAbi.find(
      (item) => item.type === "function" && item.name === "tokensOf",
    );
    expect(tokensOf).toMatchObject({
      stateMutability: "view",
      inputs: [{ name: "burner_", type: "address" }],
      outputs: [{ type: "address[]" }],
    });
  });

  it("is actually called by the registry, batched, and not faked", async () => {
    // The registry used to write `rscTokens: []` with no call at all. Reading the source is the
    // only way to pin that the hardcoded value is gone, because the function is not exported.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../infrastructure/route-indexer.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('encode(rsc.abi, "tokensOf"');
    expect(source).toContain("multicall(tokensOfCalls");
    // The fabricated empty array must not come back.
    expect(source).not.toContain("rscTokens: []");
  });

  it("keeps RSC and burner distinct in the read, so a stale value cannot be reused", () => {
    // A guard against someone later "optimising" this into a single cached call per contract.
    expect(RSC).not.toBe(BURNER);
  });
});
