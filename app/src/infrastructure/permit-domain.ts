import { keccak256, toHex, encodeAbiParameters, type PublicClient } from "viem";
import type { Address } from "@/domain/burner-route";
import { erc20Abi } from "@/config/abis";
import { withRpcRetry } from "./rpc-retry";

/**
 * The EIP-2612 `version` string a token actually uses.
 *
 * This cannot be hardcoded. EIP-2612's domain separator is
 * `keccak256(abi.encode(typeHash, keccak256(name), keccak256(version), chainId, token))`,
 * and the spec never says what `version` must be — it is simply whatever the token's author
 * put in the constructor. Most use `"1"`, but Circle's USDC uses `"2"`. Signing with the wrong
 * version produces a well-formed signature over the wrong digest, so the token reverts with
 * `EIP2612: invalid signature` and gives no hint which field was wrong.
 *
 * The token exposes `DOMAIN_SEPARATOR()`, so the version is found by computing the separator
 * for each plausible candidate and returning the one that matches. This is a real read of the
 * token, not a guess: if none match, the caller is told the version is unknown rather than
 * being handed a default that would fail on-chain.
 *
 * Candidates are deliberately few. An exhaustive search would be guessing dressed up as
 * detection; these cover the versions used by the tokens SAPU is likely to meet, and an
 * unmatched token is reported honestly.
 */
const CANDIDATE_VERSIONS = ["1", "2", "3", ""] as const;

const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

const domainSeparatorAbi = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

function computeSeparator(
  name: string,
  version: string,
  chainId: number,
  token: Address,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        token,
      ],
    ),
  );
}

/**
 * Reads the permit domain for a token: its `name`, the `version` its separator implies, and
 * the nonce for one owner.
 *
 * Returns `null` when the token does not answer `DOMAIN_SEPARATOR()` (so EIP-2612 cannot be
 * used safely) or when no candidate version reproduces it. Both are facts about the token, and
 * reporting them is better than signing something the token will reject.
 */
export async function readPermitDomain(
  client: PublicClient,
  token: Address,
  chainId: number,
): Promise<{ readonly name: string; readonly version: string } | null> {
  const [name, actual] = await Promise.all([
    withRpcRetry(() =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    ) as Promise<string>,
    withRpcRetry(() =>
      client.readContract({
        address: token,
        abi: domainSeparatorAbi,
        functionName: "DOMAIN_SEPARATOR",
      }),
    ) as Promise<`0x${string}`>,
  ]);

  for (const version of CANDIDATE_VERSIONS) {
    if (computeSeparator(name, version, chainId, token).toLowerCase() === actual.toLowerCase()) {
      return { name, version };
    }
  }
  return null;
}
