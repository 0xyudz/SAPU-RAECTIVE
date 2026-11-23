import type { ReactNode } from "react";
import type { Address } from "@/domain/burner-route";
import type { BurnerHandle } from "@/infrastructure/ephemeral-key-vault";
import { BurnerGenerator, type BurnerView } from "@/components/burner-generator";
import { PhasePill } from "@/components/proof-drawer";
import { TextField } from "@/components/primitives";
import { TONE_BADGE } from "@/components/tone";
import type { Tone } from "@/domain/tone";
import type { WritePhase } from "@/domain/tx-receipt";

export type ArmActionKey = "inspect" | "arm";

export function ArmControls({
  mounted,
  burners,
  selected,
  onSelect,
  onCreate,
  onForget,
  onPurge,
  manualBurner,
  onManualBurner,
  burnerNote,
  residueNote,
  residueTone,
  coldWallet,
  onColdWallet,
  token,
  onToken,
  tokenHint,
  canInspect,
  canArm,
  busy,
  phase,
  onInspect,
  onArm,
  children,
}: {
  mounted: boolean;
  burners: readonly BurnerHandle[];
  selected: Address | null;
  onSelect: (address: Address) => void;
  onCreate: () => void;
  onForget: (address: Address) => void;
  onPurge: () => void;
  manualBurner: string;
  onManualBurner: (value: string) => void;
  burnerNote: string;
  residueNote: string;
  /** Drives the styling. Kept separate from the text so rewording cannot silently change the colour. */
  residueTone: Tone;
  coldWallet: string;
  onColdWallet: (value: string) => void;
  token: string;
  onToken: (value: string) => void;
  tokenHint: string;
  canInspect: boolean;
  canArm: boolean;
  busy: ArmActionKey | null;
  phase: WritePhase;
  onInspect: () => void;
  onArm: () => void;
  children?: ReactNode;
}) {
  const burnerViews: BurnerView[] = burners.map((burner) => ({
    address: burner.address,
    label: burner.label,
  }));

  return (
    <div className="space-y-4">
      <BurnerGenerator
        burners={burnerViews}
        selected={selected}
        mounted={mounted}
        onCreate={onCreate}
        onSelect={onSelect}
        onForget={onForget}
        onPurge={onPurge}
      />

      <div className="panel p-5">
        <p className="label-caps">Route</p>

        <TextField
          id="arm-burner"
          label="Burner override (for resuming after reload)"
          value={manualBurner}
          onChange={onManualBurner}
          hint={burnerNote}
        />
        <p
          className={`mt-2 rounded border px-2.5 py-1.5 font-mono text-[10.5px] ${TONE_BADGE[residueTone]}`}
        >
          {residueNote}
        </p>
        <TextField id="arm-cold" label="Cold wallet" value={coldWallet} onChange={onColdWallet} />
        <TextField id="arm-token" label="Token" value={token} onChange={onToken} hint={tokenHint} />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onInspect}
            disabled={!canInspect || busy !== null}
            className="rounded border border-steel px-3 py-2 font-mono text-[11px] text-slate-300 transition-colors hover:border-steel-bright disabled:opacity-50"
          >
            {busy === "inspect" ? "reading…" : "Check chain state"}
          </button>
          <button
            type="button"
            onClick={onArm}
            disabled={!canArm || busy !== null}
            className="rounded-md bg-lime px-4 py-2 font-mono text-[12px] font-semibold text-void transition-colors hover:bg-lime-glow disabled:cursor-not-allowed disabled:bg-steel disabled:text-slate-600"
          >
            {busy === "arm" ? "arming…" : "Arm route"}
          </button>
          {phase !== "idle" && <PhasePill phase={phase} />}
        </div>
        <p className="mt-3 border-t border-steel/60 pt-3 text-[11.5px] leading-relaxed text-slate-500">
          A missing burner allowance is a failure, not a success: every sweep would revert inside transferFrom. The key
          stays in this tab and signs only the EIP-2612 permit.
        </p>
      </div>

      {children}
    </div>
  );
}
