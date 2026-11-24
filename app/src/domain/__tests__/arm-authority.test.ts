import { describe, expect, it } from "vitest";
import {
  authorityGapNote,
  canArmAnyStep,
  resolveArmAuthority,
} from "@/domain/arm-authority";
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

    expect(canArmAnyStep(authority)).toBe(false);
    expect(authority["arm-rule"].kind).toBe("wrong-owner");
  });

  it("treats a disconnected wallet as owning nothing", () => {
    const authority = resolveArmAuthority(null, {
      rscOwner: RSC_OWNER,
      forwarderOwner: FWD_OWNER,
    });

    expect(canArmAnyStep(authority)).toBe(false);
  });

  it("does not grant permission when an owner could not be read", () => {
    // An unreadable owner is unknown, not permission. Assuming it matched would let the UI
    // offer a transaction that reverts with OwnableUnauthorizedAccount.
    const authority = resolveArmAuthority(RSC_OWNER, {
      rscOwner: null,
      forwarderOwner: null,
    });

    expect(authority["set-forwarder"].kind).toBe("wrong-owner");
    expect(canArmAnyStep(authority)).toBe(false);
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
});
