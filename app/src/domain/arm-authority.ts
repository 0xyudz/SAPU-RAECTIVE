import type { Address } from "@/domain/burner-route";
import type { ArmStepId } from "@/application/registration-service";

/**
 * Which wallet may perform each step of arming a route.
 *
 * ## Why this is not one `isOwner` flag
 *
 * The four steps are owner calls on **two different contracts**, and those contracts need not
 * share an owner. `setForwarder` and `registerRoute` are `onlyOwner` on `SapuRSC`; `armRoute`
 * (and the burner-signed `approve` that sometimes precedes it) is `onlyOwner` on
 * `SapuForwarder`. A deployment can legitimately have different keys for each — the live
 * testnet stack does, because `SapuRSC` is deployed from a Reactive-network key while
 * `SapuForwarder` is deployed from the origin-chain key.
 *
 * The Arm page used to require **one wallet to own both**, which no wallet can satisfy in that
 * deployment. The Arm button was therefore disabled for every possible operator, and the only
 * way to arm a route was a script holding both keys. That is not a permission check; it is a
 * dead end.
 *
 * So authority is modelled per step. A step is allowed when the connected wallet owns the
 * contract that step writes to. Steps are still executed in order by `armRoute`, which means
 * an operator holding only one of the two keys can complete their half and resume later from
 * a wallet holding the other — which is exactly what the resumable pipeline was built for
 * (`deriveArmSteps` detects completed steps on-chain and skips them).
 */
export type ArmAuthority =
  /** The wallet that owns the contract this step writes to. */
  | { readonly kind: "allowed" }
  /** The step needs a key this wallet does not hold. */
  | {
      readonly kind: "wrong-owner";
      /** Which contract's owner is required. */
      readonly contract: "rsc" | "forwarder";
      /** The address that must sign, when it could be read. */
      readonly owner: Address | null;
    }
  /** The step writes no owner contract, so it is always runnable. */
  | { readonly kind: "permissionless" };

/** The contract each arming step writes to. `verify` writes nothing. */
const STEP_CONTRACT: Readonly<Record<ArmStepId, "rsc" | "forwarder" | null>> = {
  "set-forwarder": "rsc",
  "register-route": "rsc",
  "arm-rule": "forwarder",
  verify: null,
};

export interface ArmOwners {
  readonly rscOwner: Address | null;
  readonly forwarderOwner: Address | null;
}

/**
 * Resolves who may run each step, from the two on-chain owners and the connected wallet.
 *
 * `wallet` is null when no wallet is connected, in which case nothing is allowed. An owner that
 * could not be read makes its steps `wrong-owner` with a null owner: unknown is not permission.
 */
export function resolveArmAuthority(
  wallet: Address | null,
  owners: ArmOwners,
): Readonly<Record<ArmStepId, ArmAuthority>> {
  const connected = wallet === null ? null : wallet.toLowerCase();

  const forContract = (contract: "rsc" | "forwarder" | null): ArmAuthority => {
    if (contract === null) return { kind: "permissionless" };
    const owner = contract === "rsc" ? owners.rscOwner : owners.forwarderOwner;
    if (connected === null || owner === null) {
      return { kind: "wrong-owner", contract, owner };
    }
    return owner.toLowerCase() === connected
      ? { kind: "allowed" }
      : { kind: "wrong-owner", contract, owner };
  };

  return {
    "set-forwarder": forContract(STEP_CONTRACT["set-forwarder"]),
    "register-route": forContract(STEP_CONTRACT["register-route"]),
    "arm-rule": forContract(STEP_CONTRACT["arm-rule"]),
    verify: forContract(STEP_CONTRACT.verify),
  };
}

/**
 * Whether this wallet can make any progress at all.
 *
 * True when at least one *write* step is allowed. A wallet that owns neither contract can still
 * inspect the chain, but it cannot arm, and the UI should say so before the operator fills the
 * form. `verify` is excluded because it is a read.
 */
export function canArmAnyStep(authority: Readonly<Record<ArmStepId, ArmAuthority>>): boolean {
  return (
    authority["set-forwarder"].kind === "allowed" ||
    authority["register-route"].kind === "allowed" ||
    authority["arm-rule"].kind === "allowed"
  );
}

/**
 * A short explanation of what this wallet is missing, for the page's read-only note.
 *
 * Returns null when the wallet can arm everything, so the caller shows no note at all rather
 * than a reassuring one.
 */
export function authorityGapNote(
  authority: Readonly<Record<ArmStepId, ArmAuthority>>,
  wallet: Address | null,
): string | null {
  if (wallet === null) return "connect a wallet to sign the arming transactions";

  const blocked = (Object.keys(authority) as ArmStepId[]).filter((id) => {
    const entry = authority[id];
    return entry.kind === "wrong-owner" && STEP_CONTRACT[id] !== null;
  });

  if (blocked.length === 0) return null;

  const contracts = new Set(
    blocked.map((id) => {
      const entry = authority[id];
      return entry.kind === "wrong-owner" ? entry.contract : null;
    }),
  );

  const names = [...contracts]
    .filter((c): c is "rsc" | "forwarder" => c !== null)
    .map((c) => (c === "rsc" ? "SapuRSC" : "SapuForwarder"));

  const total = (Object.keys(authority) as ArmStepId[]).filter(
    (id) => STEP_CONTRACT[id] !== null,
  ).length;

  // When every write step is blocked there is nothing left to do from this wallet, so the note
  // must not imply otherwise. Saying "the others can" to a wallet that owns neither contract
  // would be the same kind of confident-but-false message this change is meant to remove.
  if (blocked.length === total) {
    return `this wallet does not own ${names.join(" or ")}, so none of the arming steps can be signed from it`;
  }

  return `this wallet does not own ${names.join(" or ")}, so ${
    blocked.length === 1 ? "one step" : `${blocked.length} steps`
  } cannot be signed from it — the others can, and a completed run can be resumed from the wallet that holds the missing key`;
}
