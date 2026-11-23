import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertSignatureBelongsTo,
  assertUsableScalar,
  BurnerDerivationError,
  derivationMessage,
} from "@/domain/burner-derivation";
import type { Address } from "@/domain/burner-route";

/**
 * Browser-side derivation of a burner key from a wallet signature.
 *
 * All cryptography lives here; `domain/burner-derivation.ts` owns the rules. This module
 * never persists anything — the derived key goes into the same in-memory vault as before,
 * the difference being that it can be rebuilt on demand instead of being unrecoverable.
 */

/** EIP-1193 provider, narrowed to the two methods this module needs. */
interface SigningProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function provider(): SigningProvider {
  if (typeof window === "undefined") {
    throw new BurnerDerivationError("Burner derivation is browser-only.");
  }
  const injected = (window as { ethereum?: SigningProvider }).ethereum;
  if (!injected) {
    throw new BurnerDerivationError(
      "No injected wallet. Connect a wallet before deriving a recoverable burner.",
    );
  }
  return injected;
}

/**
 * Hashes a signature into a private key.
 *
 * `keccak256` over 32 uniform bytes yields a valid scalar except for the zero value,
 * which `assertUsableScalar` rejects. The account construction is also exercised so a
 * key that the curve rejects surfaces here rather than at signing time.
 */
export function burnerKeyFromSignature(signature: `0x${string}`): `0x${string}` {
  const derived = keccak256(signature) as `0x${string}`;
  assertUsableScalar(derived);
  // Throws if the scalar is out of range for secp256k1; cheaper to find out now.
  privateKeyToAccount(derived);
  return derived;
}

export interface DerivedBurner {
  readonly address: Address;
  readonly privateKey: `0x${string}`;
  /** The exact text that was signed, so the UI can show what the wallet approved. */
  readonly message: string;
}

/**
 * Asks the connected wallet to sign the derivation message and returns the burner key.
 *
 * The recovered address is compared against the account the wallet reports, so a wallet
 * that silently signs with a different account produces an error instead of a key the
 * user cannot reproduce later.
 */
export async function deriveBurnerFromWallet(index: number): Promise<DerivedBurner> {
  const injected = provider();
  const message = derivationMessage(index);

  const accounts = (await injected.request({ method: "eth_requestAccounts" })) as string[];
  const signer = accounts[0];
  if (typeof signer !== "string") {
    throw new BurnerDerivationError("The wallet returned no account to derive from.");
  }

  const signature = (await injected.request({
    method: "personal_sign",
    params: [toHex(message), signer],
  })) as string;

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new BurnerDerivationError(`The wallet returned a malformed signature (${signature.length} chars).`);
  }

  // Recover independently rather than trusting the wallet's report about itself.
  const { recoverMessageAddress } = await import("viem");
  const recovered = await recoverMessageAddress({
    message,
    signature: signature as `0x${string}`,
  });

  assertSignatureBelongsTo({ signature, signer, recovered });

  const privateKey = burnerKeyFromSignature(signature as `0x${string}`);
  const account = privateKeyToAccount(privateKey);

  return { address: account.address.toLowerCase() as Address, privateKey, message };
}
