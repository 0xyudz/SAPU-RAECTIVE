"use client";


import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SurfaceNote } from "@/components/surface-note";
import { useApi } from "@/components/use-api";
import { POLL_INTERVAL_MS } from "@/config/constants";
import { WalletProvider, useWallet } from "./wallet";

interface HealthSummary {
  readonly originBlock: string | null;
  readonly reactiveBlock: string | null;
}

function Shell({ children }: { children: ReactNode }) {
  const { wallet, connect, sessionReceipts, clearSessionReceipts } = useWallet();
  const health = useApi<HealthSummary>("/api/health", POLL_INTERVAL_MS.health);

  return (
    <AppShell
      wallet={wallet}
      onConnect={connect}
      receipts={sessionReceipts}
      onClearReceipts={clearSessionReceipts}
      chainHealth={health.data}
    >
      <div className="space-y-6">
        <SurfaceNote />
        {children}
      </div>
    </AppShell>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <Shell>{children}</Shell>
    </WalletProvider>
  );
}
