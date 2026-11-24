import { describe, expect, it } from "vitest";
import { erc20Abi } from "@/config/abis";

/**
 * `erc20Abi` must describe the whole ERC-20 surface SAPU relies on, not just the reads.
 *
 * The bug this pins: `approve` was missing, so the burner-signed fallback in
 * `registration-service.ts` failed with `Function "approve" not found on ABI` before reaching
 * the chain. Every token without EIP-2612 was therefore unarmable — a protocol requirement SAPU
 * does not have, since the forwarder only needs a plain ERC-20 allowance.
 */
describe("erc20Abi", () => {
  const names = new Set(
    erc20Abi.filter((item) => item.type === "function").map((item) => item.name),
  );

  it("declares approve, so the no-permit fallback can build a call", () => {
    expect(names.has("approve")).toBe(true);
  });

  it("declares the reads the allowance preflight and permit signing need", () => {
    for (const required of [
      "allowance",
      "balanceOf",
      "decimals",
      "name",
      "nonces",
      "symbol",
      "transfer",
    ] as const) {
      expect(names.has(required), `erc20Abi is missing ${required}()`).toBe(true);
    }
  });

  it("declares approve as a nonpayable write returning bool, as ERC-20 specifies", () => {
    const approve = erc20Abi.find(
      (item) => item.type === "function" && item.name === "approve",
    );
    expect(approve).toBeDefined();
    expect(approve).toMatchObject({
      type: "function",
      name: "approve",
      stateMutability: "nonpayable",
      inputs: [
        { name: "spender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [{ type: "bool" }],
    });
  });

  it("declares nonces, which the permit signature must commit to", () => {
    // `permit` itself is never called by the app: the forwarder relays it via `armWithPermit`.
    // The token's `nonces()` is read here to build the signature, so it must be present.
    expect(names.has("nonces")).toBe(true);
  });
});
