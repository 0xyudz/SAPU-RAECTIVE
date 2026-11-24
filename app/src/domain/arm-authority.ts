import type { Address } from "@/domain/burner-route";
import type { ArmStepId, ArmStepState } from "@/application/registration-service";

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
 * The verdict the Arm button needs: what happens if this wallet presses it now?
 *
 * ## Why this replaced a boolean
 *
 * There used to be a predicate here, `canArmAnyStep`, that answered "is at least one write step
 * signable?". It is gone, and it must not come back: it answered a different question than the
 * button asks, and the two disagree exactly when it matters.
 *
 * `armRoute` executes the steps in a fixed order and stops at the first one it cannot complete.
 * A wallet owning only `SapuForwarder` on a fresh route passed `canArmAnyStep` — the forwarder
 * step is allowed — so the button was enabled, and the very first transaction (`setForwarder`
 * on `SapuRSC`) reverted with `OwnableUnauthorizedAccount`. The button promised progress that
 * could not happen.
 *
 * The question the button needs is *can the first unsatisfied step be signed from here?*, which
 * is what this gate answers. A predicate that ignores step order cannot answer it, so it was
 * deleted rather than kept alongside as an unused alternative.
 *
 * `steps` must be in execution order and `null` when the chain state has not been read yet —
 * without it there is no way to know which step comes first, and guessing is how the old
 * "any step is signable" rule produced a button that always reverted.
 */
export type ArmGate =
  /** The first unsatisfied step is signable from this wallet. */
  | { readonly kind: "ready"; readonly step: ArmStepId }
  /** Every step is already satisfied; pressing the button would send nothing. */
  | { readonly kind: "nothing-to-do" }
  /** Chain state not read yet, so the first step is unknown. */
  | { readonly kind: "unknown" }
  /** A step is already inconsistent on chain; the run stops there without sending. */
  | { readonly kind: "diverged"; readonly step: ArmStepId; readonly detail: string }
  /** The first unsatisfied step needs a key this wallet does not hold. */
  | {
      readonly kind: "blocked";
      readonly step: ArmStepId;
      readonly contract: "rsc" | "forwarder";
      readonly owner: Address | null;
    };

export function armGate(
  steps: readonly ArmStepState[] | null,
  authority: Readonly<Record<ArmStepId, ArmAuthority>>,
): ArmGate {
  if (steps === null) return { kind: "unknown" };

  // The pipeline is ordered, so the first step that is not already satisfied is exactly the
  // one `armRoute` will try to send. `failed` means the chain disagrees with the form, which
  // `armRoute` reports before sending anything.
  const next = steps.find((step) => step.status === "todo" || step.status === "failed");
  if (next === undefined) return { kind: "nothing-to-do" };
  if (next.status === "failed") {
    return { kind: "diverged", step: next.id, detail: next.detail };
  }

  const entry = authority[next.id];
  if (entry.kind === "allowed" || entry.kind === "permissionless") {
    return { kind: "ready", step: next.id };
  }
  return { kind: "blocked", step: next.id, contract: entry.contract, owner: entry.owner };
}

/** Human name for a step, used by the gate notes so they name what is stuck. */
const STEP_LABEL: Readonly<Record<ArmStepId, string>> = {
  "set-forwarder": "step 1 (point SapuRSC at the forwarder)",
  "register-route": "step 2 (register the route on SapuRSC)",
  "arm-rule": "step 3 (arm the destination rule)",
  verify: "step 4 (verify both sides)",
};

/**
 * Why the Arm button is not usable, or null when it is.
 *
 * Deliberately says *which* step is stuck and *which* wallet is needed, because the actionable
 * fact for a two-owner deployment is "the other key must run first", not "you own less".
 */
export function armGateNote(gate: ArmGate): string | null {
  if (gate.kind === "ready") return null;
  if (gate.kind === "nothing-to-do") {
    return "every step already agrees with the chain, so there is nothing left to send";
  }
  if (gate.kind === "unknown") {
    return "reading the on-chain state for this burner and token first, so the next step is not known yet";
  }
  if (gate.kind === "diverged") return gate.detail;
  const contract = gate.contract === "rsc" ? "SapuRSC" : "SapuForwarder";
  const who =
    gate.owner === null
      ? `the ${contract} owner, which could not be read`
      : `${contract} owner ${gate.owner}`;
  return `${STEP_LABEL[gate.step]} must run first and needs ${who} — connect that wallet and reload; completed steps are detected on chain and will not be sent twice`;
}

/**
 * A short explanation of what this wallet is missing, for the page's read-only note.
 *
 * Returns null when the wallet can arm everything, so the caller shows no note at all rather
 * than a reassuring one.
 *
 * ## "could not be read" is not "does not own"
 *
 * The owner of each contract is an `eth_call`. When that call fails — a rate-limited node, a
 * proxy that has not answered — the owner is `null`, and this note used to say the wallet
 * "does not own SapuRSC", which is a claim about both the wallet and the chain that nobody
 * observed. The wallet may well be the owner. The note now separates the two cases, because
 * the operator's next action differs: connect another wallet, or retry the read.
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

  const entries = blocked.map((id) => authority[id]).filter(
    (entry): entry is Extract<ArmAuthority, { kind: "wrong-owner" }> => entry.kind === "wrong-owner",
  );

  // Split by whether the owner is actually known. An unknown owner makes the step blocked for
  // an unknown reason, and conflating it with a known mismatch tells the operator to switch
  // wallets when the real fix is to retry the read.
  const unknown = entries.filter((entry) => entry.owner === null);
  const known = entries.filter((entry) => entry.owner !== null);

  const contractName = (contract: "rsc" | "forwarder") =>
    contract === "rsc" ? "SapuRSC" : "SapuForwarder";

  if (unknown.length === entries.length) {
    const names = [...new Set(unknown.map((entry) => contractName(entry.contract)))];
    return `the owner of ${names.join(" and ")} could not be read, so whether this wallet can sign is unknown — this is a failed read, not a verdict; retry once the node answers`;
  }

  const names = [...new Set(known.map((entry) => contractName(entry.contract)))];

  const totalWrites = (Object.keys(authority) as ArmStepId[]).filter(
    (id) => STEP_CONTRACT[id] !== null,
  ).length;

  // When every write step is blocked by a *known* mismatch there is nothing left to do from
  // this wallet, so the note must not imply otherwise. Saying "the others can" to a wallet
  // that owns neither contract would be the same kind of confident-but-false message this
  // change is meant to remove.
  if (known.length === entries.length && blocked.length === totalWrites) {
    return `this wallet does not own ${names.join(" or ")}, so none of the arming steps can be signed from it`;
  }

  const count = known.length;
  return `this wallet does not own ${names.join(" or ")}, so ${
    count === 1 ? "one step" : `${count} steps`
  } cannot be signed from it — the others can, and a completed run can be resumed from the wallet that holds the missing key${
    unknown.length > 0
      ? `; the owner of ${[...new Set(unknown.map((e) => contractName(e.contract)))].join(" and ")} could not be read`
      : ""
  }`;
}
