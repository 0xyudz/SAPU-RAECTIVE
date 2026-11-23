"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { VIEWS } from "@/config/views";
import { BASE_SEPOLIA, REACTIVE_LASNA } from "@/config/chains";
import type { TxReceipt } from "@/domain/tx-receipt";
import { ProofDrawer } from "./proof-drawer";
import { BroomMark, SiteFooter } from "./site-chrome";
import { WalletButton, type WalletView } from "./wallet-button";

interface ChainIndicatorView {
  readonly baseBlock: string | null;
  readonly reactiveBlock: string | null;
}

export function AppShell({
  wallet,
  onConnect,
  receipts = [],
  onClearReceipts,
  chainHealth,
  children,
}: {
  wallet: WalletView;
  onConnect: () => void;
  receipts?: readonly TxReceipt[];
  onClearReceipts?: () => void;
  chainHealth?: ChainIndicatorView | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-steel/80 bg-void/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-4">
            <Link href="/" className="group flex items-center gap-2.5">
              <BroomMark />
              <span className="font-mono text-sm font-semibold tracking-[0.22em] text-slate-100 group-hover:text-lime-glow">
                SAPU
              </span>
            </Link>
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600 sm:inline">
              operator surface
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="hidden items-center gap-2 rounded border border-steel/70 bg-void/60 px-2.5 py-1 font-mono text-[10px] text-slate-500 md:inline-flex"
              title="Live chain heads"
            >
              <span className="flex items-center gap-1">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    chainHealth?.baseBlock ? "bg-lime" : "bg-slate-600"
                  }`}
                />
                {BASE_SEPOLIA.shortName} ({BASE_SEPOLIA.id}){" "}
                <span className="text-slate-300">{chainHealth?.baseBlock ?? "—"}</span>
              </span>
              <span className="text-steel-bright">·</span>
              <span className="flex items-center gap-1">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    chainHealth?.reactiveBlock ? "bg-lime" : "bg-slate-600"
                  }`}
                />
                lasna ({REACTIVE_LASNA.id}){" "}
                <span className="text-slate-300">{chainHealth?.reactiveBlock ?? "—"}</span>
              </span>
            </div>

            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-expanded={drawerOpen}
              className={`rounded border px-2.5 py-1.5 font-mono text-[11px] transition-colors ${
                drawerOpen
                  ? "border-lime-dim bg-lime/10 text-lime-glow"
                  : "border-steel text-slate-400 hover:border-steel-bright hover:text-slate-200"
              }`}
            >
              Proofs ({receipts.length})
            </button>

            <Link
              href="/docs"
              className="rounded px-2.5 py-1.5 font-mono text-[11px] text-slate-500 transition-colors hover:text-slate-300"
            >
              docs
            </Link>
            <WalletButton wallet={wallet} onConnect={onConnect} />
          </div>
        </div>

        <nav className="mx-auto max-w-7xl overflow-x-auto px-5 pb-2">
          <ul className="flex gap-1">
            {VIEWS.map((view) => {
              const active = pathname === view.href;
              return (
                <li key={view.id}>
                  <Link
                    href={view.href}
                    aria-current={active ? "page" : undefined}
                    className={`inline-flex whitespace-nowrap rounded px-3 py-1.5 font-mono text-[11.5px] transition-colors ${
                      active
                        ? "bg-lime/10 text-lime-glow"
                        : "text-slate-500 hover:bg-steel/50 hover:text-slate-300"
                    }`}
                  >
                    {view.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {drawerOpen && (
          <div className="border-t border-steel/70 bg-void/95 px-5 py-4">
            <div className="mx-auto max-w-7xl">
              {receipts.length === 0 ? (
                <div className="flex items-center justify-between gap-3 rounded border border-steel/60 px-4 py-3 font-mono text-[11px] text-slate-500">
                  <span>No transactions sent in this session yet. Every confirmed or reverted write appears here.</span>
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    className="text-slate-400 hover:text-slate-200"
                  >
                    close
                  </button>
                </div>
              ) : (
                <ProofDrawer receipts={receipts} onClear={onClearReceipts} />
              )}
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>

      <SiteFooter />
    </>
  );
}
