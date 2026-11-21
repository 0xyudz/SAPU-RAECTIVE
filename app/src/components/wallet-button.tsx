"use client";

import type { ReactNode } from "react";

export interface WalletView {
  readonly available: boolean;
  readonly connected: boolean;
  readonly address: string | null;
  readonly chainId: number | null;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletButton({
  wallet,
  onConnect,
  disabled = false,
}: {
  wallet: WalletView;
  onConnect: () => void;
  disabled?: boolean;
}) {
  if (wallet.connected && wallet.address) {
    return (
      <span className="inline-flex items-center gap-2 rounded border border-steel px-2.5 py-1.5 font-mono text-[11px] text-slate-300">
        <span className="h-1.5 w-1.5 rounded-full bg-lime" aria-hidden="true" />
        {short(wallet.address)}
        {wallet.chainId !== null && <span className="text-slate-600">· {wallet.chainId}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={disabled || !wallet.available}
      className="rounded border border-lime-dim/60 bg-lime/5 px-2.5 py-1.5 font-mono text-[11px] text-lime transition-colors hover:bg-lime/10 disabled:cursor-not-allowed disabled:border-steel disabled:bg-transparent disabled:text-slate-600"
      title={wallet.available ? "Connect an injected EIP-1193 wallet" : "No injected wallet detected"}
    >
      {wallet.available ? "connect wallet" : "no wallet detected"}
    </button>
  );
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-steel/70 bg-void/40 px-3 py-2 font-mono text-[10.5px] text-slate-500">
      read-only · {children}
    </p>
  );
}
