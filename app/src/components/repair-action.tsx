"use client";

import Link from "next/link";
import type { RepairAction as RepairPlan } from "@/domain/registry";
import type { Tone } from "@/domain/tone";
import { TONE_TEXT } from "./tone";

export type RepairKind = "revoke-rsc" | "disarm-forwarder";

function OwnerGate({
  connected,
  isOwner,
  owner,
  role,
}: {
  connected: boolean;
  isOwner: boolean;
  owner: string | null;
  role: string;
}) {
  if (connected && isOwner) return null;
  if (!connected) {
    return <span className="font-mono text-[10px] text-slate-500">connect wallet</span>;
  }
  return (
    <span className="font-mono text-[10px] text-slate-500" title={owner ?? undefined}>
      read-only · {role}
    </span>
  );
}

export function RepairAction({
  repair,
  tone,
  busy,
  walletConnected,
  isOwner,
  owner,
  ownerRole,
  onRevoke,
  onDisarm,
}: {
  repair: RepairPlan;
  tone: Tone;
  busy: RepairKind | null;
  walletConnected: boolean;
  isOwner: boolean;
  owner: string | null;
  ownerRole: string;
  onRevoke: () => void;
  onDisarm: () => void;
}) {
  if (repair === null) {
    return <span className={`font-mono text-[10px] ${TONE_TEXT[tone]}`}>none</span>;
  }

  const gate = <OwnerGate connected={walletConnected} isOwner={isOwner} owner={owner} role={ownerRole} />;

  if (repair === "arm-forwarder") {
    return (
      <div className="space-y-2">
        <Link href="/app/arm" className="block font-mono text-[10.5px] text-lime-glow hover:underline">
          arm forwarder →
        </Link>
        {gate ?? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onRevoke}
            className="rounded border border-steel px-2 py-1 font-mono text-[10px] text-slate-400 transition-colors hover:border-red-900/70 hover:text-red-400 disabled:opacity-50"
          >
            {busy === "revoke-rsc" ? "working…" : "revoke RSC"}
          </button>
        )}
      </div>
    );
  }

  return (
    gate ?? (
      <button
        type="button"
        disabled={busy !== null}
        onClick={onDisarm}
        className="rounded border border-red-900/70 bg-red-950/20 px-2 py-1 font-mono text-[10px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-50"
      >
        {busy === "disarm-forwarder" ? "working…" : "disarm forwarder"}
      </button>
    )
  );
}
