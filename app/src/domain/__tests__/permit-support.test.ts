import { describe, expect, it } from "vitest";
import { readPermitSupport } from "@/infrastructure/permit-support";

/**
 * `readPermitSupport` answers "does this token implement EIP-2612?" from bytecode, following one
 * level of proxy indirection.
 *
 * The live bug this pins: Circle's USDC on Base Sepolia is a ZeppelinOS proxy. Its runtime code
 * is a ~900-byte forwarder containing no ERC-20 selectors at all, while `permit`/`nonces` live in
 * the implementation it delegates to. Searching only the proxy reported "no permit" for a token
 * that fully implements it, which pushed the operator onto the burner-signed `approve` fallback —
 * the one flow that needs native gas in the burner, and one that cannot run at all when the
 * burner is unfunded. USDC could not be armed without funding the burner first.
 *
 * The fake client below returns bytecode shaped like each real case, so the test exercises the
 * same selector search the app performs against the chain.
 */

const PERMIT = "d505accf"; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
const NONCES = "7ecebe00"; // nonces(address)

const EIP1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZEPPELINOS_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const ZERO_WORD = `0x${"0".repeat(64)}`;

const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const IMPL = "0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5";

/** A contract's runtime code, with the given selectors embedded in a dispatch table. */
function bytecode(selectors: readonly string[]): string {
  return `0x6080604052${selectors.map((s) => `63${s}14`).join("")}00`;
}

function word(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * Builds a client that answers `getCode` and `getStorageAt` from a table, and records which
 * addresses were read so the test can prove the implementation was actually consulted.
 */
function fakeClient(config: {
  code: Record<string, string>;
  storage?: Record<string, Record<string, string>>;
  failCodeFor?: readonly string[];
}) {
  const codeReads: string[] = [];
  return {
    codeReads,
    client: {
      async getCode({ address }: { address: string }) {
        const key = address.toLowerCase();
        codeReads.push(key);
        if (config.failCodeFor?.includes(key)) throw new Error("429 Request exceeds defined limit.");
        return config.code[key] ?? "0x";
      },
      async getStorageAt({ address, slot }: { address: string; slot: string }) {
        return config.storage?.[address.toLowerCase()]?.[slot.toLowerCase()] ?? ZERO_WORD;
      },
    },
  };
}

// `readPermitSupport` builds its own client via `contractTarget("token")`, so these tests
// substitute the transport rather than the client. A tiny module-level hook keeps the production
// code path intact while letting the test supply bytecode.
describe("readPermitSupport", () => {
  it("finds permit + nonces in a direct token's own bytecode", async () => {
    const { client } = fakeClient({ code: { [TOKEN]: bytecode([PERMIT, NONCES]) } });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(true);
  });

  it("reports false when the token has neither selector", async () => {
    const { client } = fakeClient({ code: { [TOKEN]: bytecode([]) } });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(false);
  });

  it("reports false when the token has permit but not nonces", async () => {
    // Half of EIP-2612 cannot produce a replay-safe signature, so it counts as unsupported.
    const { client } = fakeClient({ code: { [TOKEN]: bytecode([PERMIT]) } });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(false);
  });

  it("follows an EIP-1967 proxy to its implementation", async () => {
    const { client, codeReads } = fakeClient({
      code: { [TOKEN]: bytecode([]), [IMPL]: bytecode([PERMIT, NONCES]) },
      storage: { [TOKEN]: { [EIP1967_SLOT]: word(IMPL) } },
    });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(true);
    // The implementation must actually have been read, not assumed.
    expect(codeReads).toContain(IMPL);
  });

  it("follows a ZeppelinOS proxy to its implementation (the USDC case)", async () => {
    const { client } = fakeClient({
      code: { [TOKEN]: bytecode([]), [IMPL]: bytecode([PERMIT, NONCES]) },
      storage: { [TOKEN]: { [ZEPPELINOS_SLOT]: word(IMPL) } },
    });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(true);
  });

  it("does not treat a slot holding a non-address word as an implementation", async () => {
    // A beacon slot or a random value must not send the search to a random contract, which
    // could contain the selectors by coincidence and produce a confident wrong answer.
    const { client } = fakeClient({
      code: { [TOKEN]: bytecode([]) },
      storage: { [TOKEN]: { [EIP1967_SLOT]: `0x${"ab".repeat(32)}` } },
    });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(false);
  });

  it("returns null when the address has no code, rather than inventing a negative", async () => {
    const { client } = fakeClient({ code: {} });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBeNull();
  });

  it("returns null when the bytecode cannot be read at all", async () => {
    const { client } = fakeClient({ code: {}, failCodeFor: [TOKEN] });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBeNull();
  });

  it("falls back to the proxy's own bytecode when the implementation is unreadable", async () => {
    // The implementation address is known but its code cannot be fetched. The honest answer is
    // what the proxy itself says, not a guess in either direction.
    const { client } = fakeClient({
      code: { [TOKEN]: bytecode([PERMIT, NONCES]) },
      storage: { [TOKEN]: { [EIP1967_SLOT]: word(IMPL) } },
      failCodeFor: [IMPL],
    });
    await expect(
      readPermitSupport(TOKEN as `0x${string}`, () => client as never),
    ).resolves.toBe(true);
  });
});
