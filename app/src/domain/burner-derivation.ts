/**
 * Deterministic burner keys derived from a wallet signature.
 *
 * ## The problem this solves
 *
 * Burner keys used to be `generatePrivateKey()` stored in a module-scoped `Map`. A
 * reload destroyed them, and an address cannot be turned back into a key, so any
 * burner still holding a balance became unreachable. `rescueSweep` needs the burner's
 * own signature to grant a fresh allowance, so "the owner can always rescue it" is
 * false once the key is gone.
 *
 * ## Why a signature instead of a key file
 *
 * Writing the key to a `.txt`/`.json` fixes the loss but breaks the product's central
 * promise: SAPU exists to stop the burner from being linked to the user. A key file on
 * disk is a durable, often cloud-synced, written link between the two. Deriving the key
 * from a wallet signature keeps nothing on disk while staying reproducible: the same
 * wallet signs the same message and gets the same key back.
 *
 * ## What this module owns
 *
 * Only the parts that need no cryptography: the message to sign, the validation rules,
 * and the error type. Hashing and signing live in `infrastructure/burner-derivation.ts`
 * so `domain/` stays free of viem and of I/O.
 */

/** Domain separator, so a signature harvested for another purpose cannot be reused. */
export const BURNER_DERIVATION_PREFIX = "SAPU burner key derivation v1";

/** Thrown when a burner cannot be re-derived. Never swallowed into a `null`. */
export class BurnerDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BurnerDerivationError";
  }
}

/**
 * The message a wallet signs to derive a burner key.
 *
 * It names the burner index so one wallet can derive a whole set of unlinkable burners,
 * and it states plainly what the signature is for. A wallet showing this text is showing
 * the truth: signing it authorises no transaction and no token approval.
 *
 * The text is domain-separated on purpose. Signatures are deterministic (RFC 6979), so
 * the same message always yields the same bytes; binding the message to this application
 * and version means a signature collected by another site cannot be replayed here to
 * reproduce the user's burner, and a future change to the scheme can be versioned
 * instead of silently changing which burner a user gets.
 */
export function derivationMessage(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new BurnerDerivationError(`Burner index must be a non-negative integer, received ${index}.`);
  }
  return [
    BURNER_DERIVATION_PREFIX,
    "",
    `Burner index: ${index}`,
    "",
    "Signing this derives a burner key inside your browser. It is not a transaction,",
    "it does not move funds, and it grants no allowance. The signature never leaves",
    "this tab.",
  ].join("\n");
}

/**
 * Checks that a signature is well-formed and really came from the expected signer.
 *
 * The ownership check is not ceremony: without it a caller could hand in any signature
 * and receive a key derived from bytes the real user never produced.
 */
export function assertSignatureBelongsTo(params: {
  readonly signature: string;
  readonly signer: string;
  readonly recovered: string;
}): void {
  const { signature, signer, recovered } = params;

  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new BurnerDerivationError(
      `Expected a 65-byte signature (0x + 130 hex chars), received ${signature.length} chars.`,
    );
  }

  if (signer.toLowerCase() !== recovered.toLowerCase()) {
    throw new BurnerDerivationError(
      `The signature recovers to ${recovered}, not ${signer}. Refusing to derive a key from a signature this wallet did not produce.`,
    );
  }
}

/**
 * Rejects a derived scalar that cannot be used as a secp256k1 private key.
 *
 * Kept separate from the hashing so the rule is explicit and testable: accepting the
 * zero scalar would produce an account nobody controls.
 */
export function assertUsableScalar(candidate: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(candidate)) {
    throw new BurnerDerivationError(`Expected a 32-byte scalar, received ${candidate}.`);
  }
  if (/^0x0+$/.test(candidate)) {
    throw new BurnerDerivationError("Derived scalar is zero, which is not a valid secp256k1 key.");
  }
}
