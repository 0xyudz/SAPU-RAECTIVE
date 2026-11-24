import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex, type PublicClient } from "viem";
import { readPermitDomain } from "@/infrastructure/permit-domain";
import type { Address } from "@/domain/burner-route";

/**
 * These tests pin the rule that broke USDC arming live: the EIP-2612 `version` is whatever the
 * token put in its domain separator, not a constant.
 *
 * The real failure: `signPermit` signed with `version: "1"`. Circle's USDC uses `"2"`, so the
 * signature covered the wrong digest and the token reverted with `EIP2612: invalid signature` —
 * a message that names no field and gives the operator nothing to act on. USDC could not be
 * armed at all.
 */

const TOKEN = "0x036cbd53842c5427942541ec2318f3dcf7e00b1e" as Address;
const CHAIN_ID = 84532;

const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

/** Independently recomputes a separator, the way the token does on-chain. */
function separator(name: string, version: string, chainId: number, token: Address): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [DOMAIN_TYPEHASH, keccak256(toHex(name)), keccak256(toHex(version)), BigInt(chainId), token],
    ),
  );
}

/**
 * A stand-in client that answers only the two calls `readPermitDomain` makes.
 *
 * Deliberately not a mock of the chain: it returns the same digest a real token computes, so the
 * test proves the matching logic rather than asserting that the code agrees with itself.
 */
function fakeClient(options: {
  name: string;
  separator: `0x${string}`;
}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "name") return options.name;
      if (functionName === "DOMAIN_SEPARATOR") return options.separator;
      throw new Error(`unexpected read: ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("readPermitDomain", () => {
  it("derives version \"2\" for a USDC-style token", async () => {
    const client = fakeClient({
      name: "USDC",
      separator: separator("USDC", "2", CHAIN_ID, TOKEN),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toEqual({
      name: "USDC",
      version: "2",
    });
  });

  it("derives version \"1\" for an ordinary token", async () => {
    const client = fakeClient({
      name: "Sapu Demo Token",
      separator: separator("Sapu Demo Token", "1", CHAIN_ID, TOKEN),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toEqual({
      name: "Sapu Demo Token",
      version: "1",
    });
  });

  it("reports an undeterminable version instead of defaulting to \"1\"", async () => {
    // A token whose separator uses a version outside the candidate set. Returning "1" here would
    // reproduce the exact bug: a well-formed signature the token rejects.
    const client = fakeClient({
      name: "Odd Token",
      separator: separator("Odd Token", "v7.2", CHAIN_ID, TOKEN),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toBeNull();
  });

  it("is bound to the chain id, so a separator from another chain does not match", async () => {
    const client = fakeClient({
      name: "USDC",
      // Same token and name, but hashed for mainnet.
      separator: separator("USDC", "2", 8453, TOKEN),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toBeNull();
  });

  it("is bound to the token address, so a copy at another address does not match", async () => {
    const other = "0x00000000000000000000000000000000000000aa" as Address;
    const client = fakeClient({
      name: "USDC",
      separator: separator("USDC", "2", CHAIN_ID, other),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toBeNull();
  });

  it("does not confuse the name for the version", async () => {
    // A token literally named "1" would match if the fields were swapped.
    const client = fakeClient({
      name: "1",
      separator: separator("1", "2", CHAIN_ID, TOKEN),
    });

    await expect(readPermitDomain(client, TOKEN, CHAIN_ID)).resolves.toEqual({
      name: "1",
      version: "2",
    });
  });
});
