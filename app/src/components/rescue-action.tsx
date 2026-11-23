"use client";

import type { Residue } from "@/domain/residue";
import { rescueBlockedReason } from "@/application/rescue-service";
import type { Address } from "@/domain/burner-route";

export type RescueAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unsupported"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string }
  | { readonly kind: "blocked"; readonly detail: string };

/**
 * Decides whether a rescue button should be offered, and why not when it should not.
 *
 * Three independent reasons can make a rescue impossible, and they must not be
 * collapsed into one greyed-out button:
 *
 *  - the deployed forwarder has no `rescueSweep` (contract predates the feature),
 *  - the capability could not be read (so we do not know),
 *  - the row itself is not rescuable (empty burner, or unreadable balance).
 *
 * Saying "unavailable" for all three would be a claim the app cannot back up.
 */
export function rescueAvailability(params: {
  readonly supported: boolean | null;
  readonly residue: Residue;
  readonly coldWallet: string | null;
  readonly burner: Address;
  readonly token: Address;
  readonly forwarder: Address;
}): RescueAvailability {
  if (params.supported === false) {
    return {
      kind: "unsupported",
      detail:
        "The deployed SapuForwarder predates rescueSweep. This balance cannot be recovered by this app until the forwarder is redeployed with the rescue path.",
    };
  }
  if (params.supported === null) {
    return {
      kind: "unknown",
      detail:
        "Could not read the forwarder bytecode, so it is unknown whether this deployment supports rescueSweep.",
    };
  }
  if (params.coldWallet === null) {
    return {
      kind: "blocked",
      detail: "No armed cold wallet is known for this burner, so a rescue has no verified destination.",
    };
  }

  const blocked = rescueBlockedReason({
    forwarder: params.forwarder,
    token: params.token,
    burner: params.burner,
    coldWallet: params.coldWallet as Address,
    residue: params.residue,
    tokenSymbol: "",
    tokenDecimals: 0,
  });
  if (blocked !== null) return { kind: "blocked", detail: blocked };

  return { kind: "available" };
}

/**
 * The rescue control for one ledger row.
 *
 * When a rescue is not possible the reason is shown as text, not as a disabled
 * button with no explanation — a dead control invites the operator to keep clicking.
 */
export function RescueAction({
  availability,
  busy,
  walletConnected,
  isOwner,
  onRescue,
}: {
  availability: RescueAvailability;
  busy: boolean;
  walletConnected: boolean;
  isOwner: boolean;
  onRescue: () => void;
}) {
  if (availability.kind !== "available") {
    return (
      <span
        className="block font-mono text-[9.5px] leading-snug text-slate-600"
        title={availability.detail}
      >
        {availability.kind === "unsupported" ? "not supported" : availability.kind === "unknown" ? "support unknown" : "nothing to rescue"}
      </span>
    );
  }

  if (!walletConnected) {
    return <span className="font-mono text-[10px] text-slate-500">connect wallet</span>;
  }

  if (!isOwner) {
    return (
      <span className="font-mono text-[10px] text-slate-500" title="Rescue is an owner-only call.">
        read-only · forwarder owner
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onRescue}
      className="rounded border border-amber-900/70 bg-amber-950/20 px-2 py-1 font-mono text-[10px] text-amber-400 transition-colors hover:bg-amber-950/40 disabled:opacity-50"
      title="Moves the whole burner balance to the armed cold wallet."
    >
      {busy ? "working…" : "rescue"}
    </button>
  );
}
