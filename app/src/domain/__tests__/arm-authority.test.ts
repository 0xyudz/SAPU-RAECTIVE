import { describe, expect, it } from "vitest";
import {
  armGate,
  armGateNote,
  authorityGapNote,
  resolveArmAuthority,
} from "@/domain/arm-authority";
import type { ArmStepId, ArmStepState } from "@/application/registration-service";
import type { Address } from "@/domain/burner-route";

/**
 * These tests pin the rule that made arming impossible from the UI.
 *
 * The live testnet stack has two owners: `SapuRSC` is owned by the Reactive-network key and
 * `SapuForwarder` by the origin-chain deployer. The Arm page required one wallet to own both,
 * so the Arm button was disabled for every possible operator and only a script holding both
 * keys could arm a route.
 *
 * The steps write to two different contracts, so authority is per step. A wallet that owns only
 * one of them must be able to make the progress it is entitled to, and must be told plainly
 * which steps it cannot sign.
 */

const RSC_OWNER = "0xa5db581e96ffb5493c10691aa7321b499fd627b7" as Address;
const FWD_OWNER = "0xe0ea72f4b7c0aa896edc0618165ea782ed7431a5" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;

describe("resolveArmAuthority", () => {
  it("lets the RSC owner sign the RSC steps but not the forwarder step", () => {
    // The exact live situation. Previously this wallet was told it owned nothing.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authority["set-forwarder"].kind).toBe("allowed");
    expect(authority["register-route"].kind).toBe("allowed");
    expect(authority["arm-rule"]).toEqual({
      kind: "wrong-owner",
      contract: "forwarder",
      owner: FWD_OWNER,
    });
  });

  it("lets the forwarder owner sign only the forwarder step", () => {
    const authority = resolveArmAuthority(FWD_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authority["set-forwarder"].kind).toBe("wrong-owner");
    expect(authority["register-route"].kind).toBe("wrong-owner");
    expect(authority["arm-rule"].kind).toBe("allowed");
  });

  it("allows every write step when one wallet owns both contracts", () => {
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    expect(authority["set-forwarder"].kind).toBe("allowed");
    expect(authority["register-route"].kind).toBe("allowed");
    expect(authority["arm-rule"].kind).toBe("allowed");
  });

  it("allows nothing for a wallet that owns neither contract", () => {
    const authority = resolveArmAuthority(STRANGER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authority["set-forwarder"].kind).toBe("wrong-owner");
    expect(authority["register-route"].kind).toBe("wrong-owner");
    expect(authority["arm-rule"].kind).toBe("wrong-owner");
  });

  it("treats a disconnected wallet as owning nothing", () => {
    const authority = resolveArmAuthority(null, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authority["set-forwarder"].kind).toBe("wrong-owner");
    expect(authority["arm-rule"].kind).toBe("wrong-owner");
  });

  it("does not grant permission when an owner could not be read", () => {
    // An unreadable owner is unknown, not permission. Assuming it matched would let the UI
    // offer a transaction that reverts with OwnableUnauthorizedAccount.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: null,
      forwarderOwner: null,
    });

    expect(authority["set-forwarder"].kind).toBe("wrong-owner");
    expect(authority["arm-rule"].kind).toBe("wrong-owner");
  });

  it("compares addresses case-insensitively, since checksums vary by source", () => {
    const authority = resolveArmAuthority(
      "0xA5DB581E96FFB5493C10691AA7321B499FD627B7" as Address,
      { rscOwner: RSC_OWNER, forwarderOwner: FWD_OWNER },
    );

    expect(authority["set-forwarder"].kind).toBe("allowed");
  });

  it("marks verify as permissionless, because it only reads", () => {
    const authority = resolveArmAuthority(STRANGER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authority.verify.kind).toBe("permissionless");
  });
});

describe("authorityGapNote", () => {
  it("names only the contract the wallet is missing", () => {
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    const note = authorityGapNote(authority, RSC_OWNER);
    expect(note).toContain("SapuForwarder");
    expect(note).not.toContain("SapuRSC");
  });

  it("says nothing when the wallet can sign every step", () => {
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    expect(authorityGapNote(authority, RSC_OWNER)).toBeNull();
  });

  it("asks for a wallet when none is connected", () => {
    const authority = resolveArmAuthority(null, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authorityGapNote(authority, null)).toContain("connect");
  });

  it("does not claim the run is impossible, because it can be resumed", () => {
    // The point of per-step authority: the operator can do their half and resume later from
    // the other key. The note must not read like a dead end.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(authorityGapNote(authority, RSC_OWNER)).toContain("resumed");
  });

  it("does not offer false hope to a wallet that owns neither contract", () => {
    // Saying "the others can" here would be the same confident-but-false message this change
    // removes. When every write step is blocked, the note says so plainly.
    const authority = resolveArmAuthority(STRANGER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    const note = authorityGapNote(authority, STRANGER);
    expect(note).toContain("none of the arming steps");
    expect(note).not.toContain("the others can");
    expect(note).not.toContain("resumed");
  });

  it("says the owner could not be read instead of claiming the wallet does not own it", () => {
    // An owner read is an eth_call. When it fails the owner is null, and the old note asserted
    // "this wallet does not own SapuRSC" — a claim about the wallet and the chain that nobody
    // observed. The operator's fix differs: retry the read, do not go looking for another key.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: null,
      forwarderOwner: null,
    });

    const note = authorityGapNote(authority, RSC_OWNER);
    expect(note).toContain("could not be read");
    expect(note).toContain("not a verdict");
    expect(note).not.toContain("does not own");
  });
});

/** Pipeline steps in execution order, with `statuses` applied by id. */
function steps(statuses: Partial<Record<ArmStepId, ArmStepState["status"]>>): ArmStepState[] {
  const order: ArmStepId[] = ["set-forwarder", "register-route", "arm-rule", "verify"];
  return order.map((id) => ({
    id,
    status: statuses[id] ?? "todo",
    detail: statuses[id] === "failed" ? "SapuRSC has a different destination." : "",
    receipts: [],
  }));
}

describe("armGate", () => {
  it("blocks a forwarder-only owner when the first unsatisfied step is an RSC call", () => {
    // The regression: `canArmAnyStep` returned true because step 3 was signable, so the button
    // was enabled, and the very first transaction (`setForwarder` on SapuRSC) reverted with
    // OwnableUnauthorizedAccount. The run cannot start, so the button must not promise it can.
    const authority = resolveArmAuthority(FWD_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    const verdict = armGate(steps({}), authority);

    expect(verdict).toEqual({
      kind: "blocked",
      step: "set-forwarder",
      contract: "rsc",
      owner: RSC_OWNER,
    });
    expect(armGateNote(verdict)).toContain("SapuRSC");
  });

  it("allows the forwarder-only owner once the RSC steps are already satisfied", () => {
    // The resumable pipeline is the whole reason per-step authority exists: the RSC half is
    // done, so this wallet's step is genuinely next.
    const authority = resolveArmAuthority(FWD_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    const verdict = armGate(
      steps({ "set-forwarder": "skipped", "register-route": "skipped" }),
      authority,
    );

    expect(verdict).toEqual({ kind: "ready", step: "arm-rule" });
    expect(armGateNote(verdict)).toBeNull();
  });

  it("refuses to guess while the chain state is unread", () => {
    // With no snapshot the first step is unknown. The old predicate treated "no information" as
    // permission; an unread chain is not a licence to offer a transaction.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    const verdict = armGate(null, authority);

    expect(verdict.kind).toBe("unknown");
    expect(armGateNote(verdict)).toContain("reading");
  });

  it("reports a completed route as nothing to do rather than as ready", () => {
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    const verdict = armGate(
      steps({
        "set-forwarder": "skipped",
        "register-route": "skipped",
        "arm-rule": "skipped",
        verify: "done",
      }),
      authority,
    );

    expect(verdict.kind).toBe("nothing-to-do");
    expect(armGateNote(verdict)).toContain("nothing left to send");
  });

  it("stops on a diverged step instead of offering a signature", () => {
    // `armRoute` returns the divergence before sending, so a button press would produce no
    // transaction. The gate surfaces the divergence as the reason. The earlier steps are marked
    // satisfied because that is the only way the diverged step can be the *next* one: the run
    // executes in order and stops at the first step it cannot complete.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    const verdict = armGate(
      steps({ "set-forwarder": "skipped", "register-route": "failed" }),
      authority,
    );

    expect(verdict.kind).toBe("diverged");
    expect(armGateNote(verdict)).toBe("SapuRSC has a different destination.");
  });

  it("treats an earlier unsatisfied step as the next one, whatever fails later", () => {
    // The run stops at the first step it cannot complete, so a divergence further down the
    // pipeline is not the reason the button would fail — the earlier step is. This pins the
    // ordering: `armGate` must not skip ahead to the most alarming step.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: RSC_OWNER,
      forwarderOwner: RSC_OWNER,
    });

    const verdict = armGate(steps({ "register-route": "failed" }), authority);

    expect(verdict).toEqual({ kind: "ready", step: "set-forwarder" });
  });
});
