"use client";

import { useState } from "react";
import type { Address } from "@/domain/burner-route";
import { backupFileName, buildBurnerBackup, parseBurnerBackup, serialiseBackup } from "@/domain/burner-backup";

/**
 * Burner key recovery controls.
 *
 * Three things can go wrong with an ephemeral burner, and they need different answers:
 *
 *  - the tab is reloaded and the key is gone, but the wallet that derived it is still
 *    connected  -> re-derive, nothing to remember;
 *  - the key came from `generatePrivateKey` and was never exported -> unrecoverable, and
 *    the UI says so instead of pretending;
 *  - the operator chose to keep a backup -> restore it from the file.
 *
 * Every destructive or identity-revealing action is behind a click, and the export path
 * states what it costs rather than presenting a download as a convenience.
 */
export function BurnerRecovery({
  selected,
  hasKey,
  privateKey,
  chainId,
  onDerive,
  onAdopt,
  onExport,
  onError,
}: {
  selected: Address | null;
  hasKey: boolean;
  privateKey: `0x${string}` | null;
  chainId: number;
  onDerive: (index: number) => Promise<void>;
  onAdopt: (privateKey: `0x${string}`, address: Address) => void;
  onExport: (json: string, fileName: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState<"none" | "restore" | "export">("none");
  const [index, setIndex] = useState("0");
  const [pasted, setPasted] = useState("");
  const [confirmExport, setConfirmExport] = useState(false);
  // Owned here rather than passed in: derivation waits on a wallet prompt that can take
  // arbitrarily long, and a second click during that window would open a second prompt.
  const [deriving, setDeriving] = useState(false);

  const runDerive = async () => {
    if (deriving) return;
    const parsed = Number.parseInt(index, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      onError("Burner index must be a whole number, 0 or higher.");
      return;
    }
    setDeriving(true);
    try {
      await onDerive(parsed);
      setOpen("none");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeriving(false);
    }
  };

  const runRestore = () => {
    try {
      const backup = parseBurnerBackup(pasted);
      onAdopt(backup.privateKey, backup.address);
      setPasted("");
      setOpen("none");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Key recovery</p>
        <span className="font-mono text-[10px] text-slate-600">
          {hasKey ? "key in this tab" : "no key in this tab"}
        </span>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
        A burner key lives in this tab only. If you reload, a burner created with{" "}
        <span className="font-mono text-slate-400">generate</span> cannot be rebuilt — unless you derived
        it from your wallet, or kept a backup.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setOpen(open === "restore" ? "none" : "restore")}
          className="rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-300 transition-colors hover:border-steel-bright"
        >
          Re-derive from wallet
        </button>
        <button
          type="button"
          onClick={() => setOpen(open === "export" ? "none" : "export")}
          disabled={selected === null || !hasKey}
          className="rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-300 transition-colors hover:border-steel-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back up key
        </button>
      </div>

      {open === "restore" && (
        <div className="mt-4 rounded border border-steel/70 bg-void/40 p-3">
          <label className="label-caps" htmlFor="derive-index">
            Burner index
          </label>
          <input
            id="derive-index"
            value={index}
            onChange={(event) => setIndex(event.target.value)}
            inputMode="numeric"
            className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none"
          />
          <p className="mt-1.5 font-mono text-[10px] text-slate-600">
            The same wallet and index always produce the same burner. Your wallet will ask you to sign a
            message — not a transaction.
          </p>
          <button
            type="button"
            onClick={() => void runDerive()}
            disabled={deriving}
            className="mt-3 w-full rounded-md bg-lime px-3 py-2 font-mono text-[12px] font-semibold text-void transition-colors hover:bg-lime-glow disabled:bg-steel disabled:text-slate-600"
          >
            {deriving ? "waiting for signature…" : "Derive burner"}
          </button>

          <div className="mt-4 border-t border-steel/60 pt-3">
            <label className="label-caps" htmlFor="restore-json">
              …or paste a backup file
            </label>
            <p className="mt-1 font-mono text-[10px] text-slate-600">
              Open the downloaded JSON in a text editor and paste its full contents here.
            </p>
            <textarea
              id="restore-json"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              spellCheck={false}
              className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-lime-dim focus:outline-none"
            />
            <button
              type="button"
              onClick={runRestore}
              disabled={pasted.trim() === ""}
              className="mt-2 w-full rounded border border-steel px-3 py-1.5 font-mono text-[11px] text-slate-300 transition-colors hover:border-steel-bright disabled:opacity-40"
            >
              Restore from backup
            </button>
          </div>
        </div>
      )}

      {open === "export" && selected !== null && hasKey && privateKey !== null && (
        <div className="mt-4 rounded border border-amber-900/60 bg-amber-950/20 p-3">
          <p className="font-mono text-[11px] leading-relaxed text-amber-500">
            A backup file links you to this burner and lets anyone who finds it drain the balance. It is
            the one thing SAPU otherwise avoids creating. Store it offline and delete it once the burner
            is empty.
          </p>
          {!confirmExport ? (
            <button
              type="button"
              onClick={() => setConfirmExport(true)}
              className="mt-3 rounded border border-amber-900/70 px-3 py-1.5 font-mono text-[11px] text-amber-400 transition-colors hover:bg-amber-950/40"
            >
              I understand — create the file
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const backup = buildBurnerBackup({
                  address: selected,
                  privateKey,
                  chainId,
                });
                onExport(serialiseBackup(backup), backupFileName(selected));
                setConfirmExport(false);
                setOpen("none");
              }}
              className="mt-3 rounded border border-amber-900/70 bg-amber-950/40 px-3 py-1.5 font-mono text-[11px] text-amber-300"
            >
              Download {backupFileName(selected)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
