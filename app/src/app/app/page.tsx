"use client";

/**
 * The console: burner generation, route arming, QR deposit, live watcher.
 *
 * State lives in the browser. The only server interaction is reading chain data
 * through the API route, and the only secret — the burner key — never leaves this tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BurnerGenerator } from "@/components/burner-generator";
import { QrDepositCard } from "@/components/qr-deposit-card";
import { LiveWatcher } from "@/components/live-watcher";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import type { BurnerHandle } from "@/infrastructure/ephemeral-key-vault";
import type { SweepReceipt } from "@/domain/sweep-receipt";
import type { Address } from "@/domain/burner-route";
import { createRoute, InvalidRouteError } from "@/domain/burner-route";

interface HealthResponse {
  baseBlock: string | null;
  reactiveBlock: string | null;
  token: { address: string; symbol: string; decimals: number } | null;
  forwarder: string | null;
  rsc: string | null;
  configured: boolean;
  error?: string;
}

const DEFAULT_CHAIN_ID = 84532;

export default function ConsolePage() {
  const [selected, setSelected] = useState<BurnerHandle | null>(null);
  const [coldWallet, setColdWallet] = useState("");
  const [tokenAddress, setTokenAddress] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<SweepReceipt[]>([]);
  const [watching, setWatching] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const stopRef = useRef<(() => void) | null>(null);

  // ---- Health: real chain heads, so the pulse reflects reality ----
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setHealthError(data.error ?? null);
          if (data.token && !tokenAddress) setTokenAddress(data.token.address);
        }
      } catch (error) {
        if (!cancelled) {
          setHealthError(error instanceof Error ? error.message : "unreachable");
        }
      }
    };

    void tick();
    const id = setInterval(tick, 6_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Validation mirrors the domain rules, not a second copy of them ----
  const validation = useMemo(() => {
    if (!selected) return { ok: false, reason: "Generate a burner first." };
    if (!coldWallet) return { ok: false, reason: "Enter your cold wallet address." };
    if (!tokenAddress) return { ok: false, reason: "Token address is not configured." };

    try {
      createRoute({
        burner: selected.address,
        coldWallet,
        token: tokenAddress,
        tokenSymbol: health?.token?.symbol ?? "SAPU",
        tokenDecimals: health?.token?.decimals ?? 18,
        chainId: DEFAULT_CHAIN_ID,
      });
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: error instanceof InvalidRouteError ? error.message : "Invalid route." };
    }
  }, [selected, coldWallet, tokenAddress, health]);

  // ---- Start/stop the watcher ----
  const startWatching = useCallback(
    (burner: Address, token: Address, cold: Address) => {
      stopRef.current?.();

      const controller = new AbortController();
      setWatching(true);
      setWatchError(null);

      const run = async () => {
        try {
          const res = await fetch(
            `/api/watch?burner=${burner}&token=${token}&cold=${cold}&fromBlock=latest`,
            { signal: controller.signal, cache: "no-store" },
          );
          if (!res.ok) throw new Error(`watch failed: ${res.status}`);
          const data = (await res.json()) as { receipts: SweepReceipt[] };
          setReceipts(data.receipts);
        } catch (error) {
          if (!controller.signal.aborted) {
            setWatchError(error instanceof Error ? error.message : "watch failed");
          }
        } finally {
          if (!controller.signal.aborted) {
            // Polling loop: the server does the chain reads, the client just refreshes.
            setTimeout(run, 3_000);
          }
        }
      };

      void run();
      stopRef.current = () => controller.abort();
    },
    [],
  );

  useEffect(() => {
    return () => {
      stopRef.current?.();
    };
  }, []);

  const handleArm = useCallback(() => {
    setFormError(null);
    if (!validation.ok || !selected) {
      setFormError(validation.reason);
      return;
    }

    try {
      const { route } = createRoute({
        burner: selected.address,
        coldWallet,
        token: tokenAddress,
        tokenSymbol: health?.token?.symbol ?? "SAPU",
        tokenDecimals: health?.token?.decimals ?? 18,
        chainId: DEFAULT_CHAIN_ID,
      });

      setArmed(true);
      startWatching(route.burner, route.token, route.coldWallet);
    } catch (error) {
      setFormError(error instanceof InvalidRouteError ? error.message : "Invalid route.");
    }
  }, [validation, selected, coldWallet, tokenAddress, health, startWatching]);

  const configured = health?.configured ?? false;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Console</h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Generate a burner, arm the route once, then forget about it.
            </p>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10.5px]">
            {configured ? (
              <span className="rounded border border-lime-dim/60 bg-lime/5 px-2 py-1 text-lime">
                contracts configured
              </span>
            ) : (
              <span className="rounded border border-amber-900/60 bg-amber-950/20 px-2 py-1 text-amber-500">
                contracts not configured — see .env.example
              </span>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[340px_1fr]">
          {/* ---- Left column: identity + route ---- */}
          <div className="space-y-4">
            <BurnerGenerator onSelect={setSelected} selected={selected?.address ?? null} />

            <div className="panel p-5">
              <p className="label-caps">Route</p>

              <label className="label-caps mt-4 block" htmlFor="cold-wallet">
                Cold wallet
              </label>
              <input
                id="cold-wallet"
                type="text"
                value={coldWallet}
                onChange={(event) => setColdWallet(event.target.value)}
                placeholder="0x…"
                spellCheck={false}
                className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 placeholder:text-slate-700 focus:border-lime-dim focus:outline-none"
              />

              <label className="label-caps mt-3 block" htmlFor="token">
                Token
              </label>
              <input
                id="token"
                type="text"
                value={tokenAddress}
                onChange={(event) => setTokenAddress(event.target.value)}
                placeholder="0x…"
                spellCheck={false}
                className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 placeholder:text-slate-700 focus:border-lime-dim focus:outline-none"
              />
              {health?.token && (
                <p className="mt-1.5 font-mono text-[10px] text-slate-600">
                  {health.token.symbol} · {health.token.decimals} decimals
                </p>
              )}

              <button
                type="button"
                onClick={handleArm}
                disabled={!validation.ok || armed}
                className="mt-4 w-full rounded-md bg-lime px-4 py-2.5 font-mono text-sm font-semibold text-void transition-colors hover:bg-lime-glow disabled:cursor-not-allowed disabled:bg-steel disabled:text-slate-600"
              >
                {armed ? "Route armed — watching" : "Arm route"}
              </button>

              {(formError ?? (validation.ok ? null : validation.reason)) && (
                <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-amber-500">
                  {formError ?? validation.reason}
                </p>
              )}

              <p className="mt-3 border-t border-steel/60 pt-3 text-[11.5px] leading-relaxed text-slate-500">
                Arming is a one-time action. After this, the burner is safe to fund from anywhere — it holds no gas
                and needs none.
              </p>
            </div>
          </div>

          {/* ---- Right column: deposit + watcher ---- */}
          <div className="space-y-4">
            {selected ? (
              <QrDepositCard
                address={selected.address}
                token={tokenAddress || "0x0000000000000000000000000000000000000000"}
                symbol={health?.token?.symbol ?? "SAPU"}
                decimals={health?.token?.decimals ?? 18}
                chainId={DEFAULT_CHAIN_ID}
              />
            ) : (
              <div className="panel p-5">
                <p className="label-caps">Deposit to burner</p>
                <p className="mt-3 text-[12.5px] leading-relaxed text-slate-500">
                  Generate a burner to reveal its deposit QR code.
                </p>
              </div>
            )}

            <LiveWatcher
              receipts={receipts}
              baseHead={health?.baseBlock ? BigInt(health.baseBlock) : null}
              reactiveHead={health?.reactiveBlock ? BigInt(health.reactiveBlock) : null}
              watching={watching && !watchError}
              error={watchError ?? healthError}
              burnerAddress={selected?.address ?? null}
            />
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
