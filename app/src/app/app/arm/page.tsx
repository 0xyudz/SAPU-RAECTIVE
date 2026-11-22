"use client";


import { useCallback, useEffect, useState } from "react";
import { BASE_SEPOLIA } from "@/config/chains";
import type { RouteIndex } from "@/infrastructure/route-indexer";
import type { Address } from "@/domain/burner-route";
import {
  armRoute,
  deriveArmSteps,
  type ArmStepId,
  type ArmStepState,
  type ArmStepStatus,
  type ArmingOutcome,
  type ArmingSnapshot,
  type PolicyDivergence,
  type RegisterInput,
} from "@/application/registration-service";
import {
  createBurner,
  forgetBurner,
  keyCount,
  listBurners,
  purgeAll,
  revealSecret,
  type BurnerHandle,
} from "@/infrastructure/ephemeral-key-vault";
import { createArmWriter } from "@/infrastructure/arm-writer";
import {
  BurnerGenerator,
  useBurnerMounted,
  type BurnerView,
} from "@/components/burner-generator";
import { LiveBadge } from "@/components/live-badge";
import { FailureReport, PhasePill, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { ReadOnlyNote } from "@/components/wallet-button";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "../use-write";
import { useWallet } from "../wallet";

interface HealthResponse {
  baseBlock: string | null;
  reactiveBlock: string | null;
  token: { address: string; symbol: string; decimals: number } | null;
  forwarder: string | null;
  rsc: string | null;
  configured: boolean;
  error?: string;
}

const STEP_LABEL: Record<ArmStepId, string> = {
  "set-forwarder": "1 · point SapuRSC at the forwarder",
  "register-route": "2 · register the route on SapuRSC",
  "arm-rule": "3 · arm the destination rule (and EIP-2612 permit)",
  verify: "4 · verify both sides",
};

function isFullAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export default function ArmPage() {
  const mounted = useBurnerMounted();
  const [burners, setBurners] = useState<BurnerHandle[]>([]);
  const [selected, setSelected] = useState<Address | null>(null);
  const [manualBurner, setManualBurner] = useState("");
  const [coldWallet, setColdWallet] = useState("");
  const [token, setToken] = useState("");
  const [snapshot, setSnapshot] = useState<ArmingSnapshot | null>(null);
  const [outcome, setOutcome] = useState<ArmingOutcome | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const health = useApi<HealthResponse>("/api/health", 12_000);
  const routes = useApi<RouteIndex>("/api/routes", 20_000);
  const { wallet, connect } = useWallet();
  const gate = useWriteGate();

  const refreshBurners = useCallback(() => {
    const next = listBurners();
    setBurners(next);
    setSelected((current) => {
      if (current && next.some((burner) => burner.address === current)) return current;
      return next[0]?.address ?? null;
    });
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(refreshBurners, 0);
    return () => clearTimeout(timer);
  }, [mounted, refreshBurners]);

  const verified = routes.data?.verified === true;
  const rsc = verified ? (routes.data?.rsc ?? null) : null;
  const forwarder = verified ? (routes.data?.forwarder ?? null) : null;
  const effectiveToken = token || (verified ? (routes.data?.token ?? "") : "");

  const burnerViews: BurnerView[] = burners.map((burner) => ({
    address: burner.address,
    label: burner.label,
  }));

  const activeBurner: Address | null = isFullAddress(manualBurner)
    ? (manualBurner.toLowerCase() as Address)
    : selected;

  const tokenSymbol = health.data?.token?.symbol ?? "SAPU";
  const tokenDecimals = health.data?.token?.decimals ?? 18;

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isOwner =
    walletAddress !== null &&
    walletAddress === routes.data?.rscOwner &&
    walletAddress === routes.data?.forwarderOwner;

  const canInspect = activeBurner !== null && rsc !== null && forwarder !== null && isFullAddress(effectiveToken);

  const burnerKey = useCallback((): `0x${string}` | null => {
    if (activeBurner === null) return null;
    try {
      return revealSecret(activeBurner).privateKey;
    } catch {
      return null;
    }
  }, [activeBurner]);

  const inspect = useCallback(async () => {
    if (!canInspect || activeBurner === null || rsc === null || forwarder === null) return;
    setLocalError(null);
    try {
      const port = createArmWriter({ burnerPrivateKey: burnerKey() });
      setSnapshot(
        await port.inspect({
          rsc: rsc as Address,
          forwarder: forwarder as Address,
          burner: activeBurner,
          token: effectiveToken as Address,
        }),
      );
    } catch (error) {
      setSnapshot(null);
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }, [activeBurner, burnerKey, canInspect, effectiveToken, forwarder, rsc]);

  useEffect(() => {
    if (!canInspect || activeBurner === null || rsc === null || forwarder === null) return;
    let cancelled = false;
    const runInspect = async () => {
      try {
        const port = createArmWriter({ burnerPrivateKey: burnerKey() });
        const next = await port.inspect({
          rsc: rsc as Address,
          forwarder: forwarder as Address,
          burner: activeBurner,
          token: effectiveToken as Address,
        });
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch (error) {
        if (!cancelled) {
          setSnapshot(null);
          setLocalError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void runInspect();
    return () => {
      cancelled = true;
    };
  }, [activeBurner, burnerKey, canInspect, effectiveToken, forwarder, rsc]);

  const effectiveSnapshot = canInspect ? snapshot : null;

  const run = useCallback(async () => {
    setLocalError(null);
    setOutcome(null);
    gate.reset();

    if (!verified || rsc === null || forwarder === null) {
      setLocalError(routes.data?.error ?? "Contracts are not configured and verified with eth_getCode.");
      return;
    }
    if (!isOwner) {
      setLocalError(wallet.connected ? "This wallet is not the owner of both contracts." : "connect wallet");
      return;
    }
    if (activeBurner === null) {
      setLocalError("Select, generate, or paste a burner address first.");
      return;
    }
    if (!isFullAddress(effectiveToken) || !isFullAddress(coldWallet)) {
      setLocalError("Token and cold wallet must be full 0x addresses.");
      return;
    }

    const key = burnerKey();
    const input: RegisterInput = {
      rsc: rsc as Address,
      forwarder: forwarder as Address,
      burner: activeBurner,
      coldWallet,
      token: effectiveToken,
      tokenSymbol,
      tokenDecimals,
      chainId: BASE_SEPOLIA.id,
    };

    setBusy(true);
    try {
      const result = await armRoute(
        createArmWriter({ burnerPrivateKey: key }),
        input,
        gate.options,
      );
      setOutcome(result);
      routes.refresh();
      void inspect();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    activeBurner,
    burnerKey,
    coldWallet,
    effectiveToken,
    forwarder,
    gate,
    inspect,
    isOwner,
    rsc,
    routes,
    tokenDecimals,
    tokenSymbol,
    verified,
    wallet.connected,
  ]);

  const progress = outcome !== null && !outcome.ok ? outcome : null;
  const divergence: PolicyDivergence | undefined = progress?.divergence;
  const displaySteps: readonly ArmStepState[] =
    outcome?.steps ??
    (effectiveSnapshot !== null && forwarder !== null
      ? deriveArmSteps(effectiveSnapshot, {
          forwarder: forwarder as Address,
          coldWallet: isFullAddress(coldWallet) ? (coldWallet.toLowerCase() as Address) : null,
        })
      : EMPTY_STEPS);
  const keyInVault = burnerKey() !== null;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Arm a route</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            Four steps, each simulated first and skipped when the chain already agrees. Reload after a partial run:
            completed steps are detected on-chain and will not be sent twice.
          </p>
        </div>
        <LiveBadge
          state={
            routes.data === null
              ? routes.loading && routes.error === null
                ? "loading"
                : "offline"
              : !routes.data.configured
                ? "unconfigured"
                : routes.data.verified
                  ? "live"
                  : "degraded"
          }
          detail={routes.error ?? (isOwner ? "owner wallet connected" : "owner signature required")}
        />
      </header>

      {(localError ?? health.error ?? routes.error) && (
        <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-500">
          {localError ?? health.error ?? routes.error}
        </p>
      )}

      {!wallet.connected ? (
        <ReadOnlyNote>
          <button type="button" onClick={connect} className="text-lime-glow hover:underline">
            connect wallet
          </button>{" "}
          to sign the arming transactions
        </ReadOnlyNote>
      ) : !isOwner ? (
        <ReadOnlyNote>owner only — this wallet cannot call setForwarder, registerRoute or armRoute</ReadOnlyNote>
      ) : null}

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} busy={busy} />
      <FailureReport reason={gate.failure?.reason ?? null} decoded={gate.failure?.decoded} onClear={gate.clearFailure} />

      {divergence && (
        <section className="rounded-lg border border-red-900/70 bg-red-950/20 p-4">
          <p className="font-mono text-[11px] tracking-wider text-red-300">POLICY DIVERGENCE · {divergence.side.toUpperCase()}</p>
          <dl className="mt-2 grid gap-1 font-mono text-[11px] sm:grid-cols-[8rem_1fr]">
            <dt className="text-slate-500">expected</dt>
            <dd className="break-all text-lime-glow">{divergence.expected}</dd>
            <dt className="text-slate-500">actual</dt>
            <dd className="break-all text-red-300">{divergence.actual ?? "unset"}</dd>
            <dt className="text-slate-500">side</dt>
            <dd className="text-slate-300">{divergence.side}</dd>
          </dl>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{divergence.detail}</p>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <BurnerGenerator
            burners={burnerViews}
            selected={selected}
            keyCount={mounted ? keyCount() : 0}
            mounted={mounted}
            onCreate={() => {
              const burner = createBurner();
              refreshBurners();
              setManualBurner("");
              setSelected(burner.address);
            }}
            onSelect={(address) => {
              setManualBurner("");
              setSelected(address as Address);
            }}
            onForget={(address) => {
              forgetBurner(address);
              refreshBurners();
            }}
            onPurge={() => {
              purgeAll();
              refreshBurners();
            }}
          />

          <div className="panel p-5">
            <p className="label-caps">Route</p>

            <label className="label-caps mt-4 block" htmlFor="arm-burner">
              Burner override (for resuming after reload)
            </label>
            <input
              id="arm-burner"
              value={manualBurner}
              onChange={(event) => setManualBurner(event.target.value)}
              spellCheck={false}
              className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none"
            />
            <p className="mt-1 font-mono text-[10px] text-slate-600">
              {activeBurner === null
                ? "no burner selected"
                : keyInVault
                  ? `ephemeral key in tab · EIP-2612 armWithPermit ready`
                  : "no key in tab · can inspect/resume if allowance already exists"}
            </p>

            <label className="label-caps mt-4 block" htmlFor="arm-cold">
              Cold wallet
            </label>
            <input
              id="arm-cold"
              value={coldWallet}
              onChange={(event) => setColdWallet(event.target.value)}
              spellCheck={false}
              className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none"
            />

            <label className="label-caps mt-3 block" htmlFor="arm-token">
              Token
            </label>
            <input
              id="arm-token"
              value={effectiveToken}
              onChange={(event) => setToken(event.target.value)}
              spellCheck={false}
              className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none"
            />
            <p className="mt-1.5 font-mono text-[10px] text-slate-600">
              {tokenSymbol} · {tokenDecimals} decimals · Base Sepolia
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void inspect()}
                disabled={!canInspect}
                className="rounded border border-steel px-3 py-2 font-mono text-[11px] text-slate-300 transition-colors hover:border-steel-bright disabled:opacity-50"
              >
                Check chain state
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={!isOwner || activeBurner === null || !verified || busy}
                className="rounded-md bg-lime px-4 py-2 font-mono text-[12px] font-semibold text-void transition-colors hover:bg-lime-glow disabled:cursor-not-allowed disabled:bg-steel disabled:text-slate-600"
              >
                {busy ? "arming…" : "Arm route"}
              </button>
              {gate.phase !== "idle" && <PhasePill phase={gate.phase} />}
            </div>
            <p className="mt-3 border-t border-steel/60 pt-3 text-[11.5px] leading-relaxed text-slate-500">
              A missing burner allowance is a failure, not a success: every sweep would revert inside transferFrom.
              The key stays in this tab and signs only the EIP-2612 permit.
            </p>
          </div>

          {effectiveSnapshot && (
            <div className="panel p-5">
              <p className="label-caps">On-chain state</p>
              <dl className="mt-3 grid gap-1 font-mono text-[10.5px]">
                <Row label="RSC.forwarder" value={effectiveSnapshot.forwarder ?? "unset"} />
                <Row label="route.active" value={String(effectiveSnapshot.routeActive)} />
                <Row label="route.coldWallet" value={effectiveSnapshot.routeColdWallet ?? "unset"} />
                <Row label="rule.armed" value={String(effectiveSnapshot.ruleArmed)} />
                <Row label="rule.coldWallet" value={effectiveSnapshot.ruleColdWallet ?? "unset"} />
                <Row label="allowance" value={effectiveSnapshot.allowance.toString()} />
              </dl>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <section className="panel p-5">
            <div className="flex items-center justify-between">
              <p className="label-caps">Pipeline</p>
              <span className="font-mono text-[10px] text-slate-600">
                {outcome?.ok ? "armed" : outcome ? "stopped" : "not started"}
              </span>
            </div>

            <ol className="mt-4 space-y-2">
              {displaySteps.map((step) => (
                <li
                  key={step.id}
                  className="flex items-start gap-3 rounded border border-steel/60 bg-void/30 px-3 py-2.5"
                >
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${stepDot(step.status)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-slate-200">{STEP_LABEL[step.id]}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">{step.status}</span>
                    </div>
                    {step.detail && (
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{step.detail}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            {outcome?.ok && (
              <p className="mt-4 rounded border border-lime-dim/60 bg-lime/5 px-3 py-2 font-mono text-[11px] text-lime">
                Both sides agree. The route is armed and the allowance is non-zero.
              </p>
            )}
          </section>

          <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />
        </div>
      </div>
    </div>
  );
}

const EMPTY_STEPS: readonly ArmStepState[] = [
  { id: "set-forwarder", status: "todo", detail: "", receipts: [] },
  { id: "register-route", status: "todo", detail: "", receipts: [] },
  { id: "arm-rule", status: "todo", detail: "", receipts: [] },
  { id: "verify", status: "todo", detail: "", receipts: [] },
];

function stepDot(status: ArmStepStatus): string {
  if (status === "done") return "bg-lime";
  if (status === "skipped") return "bg-sky-400";
  if (status === "failed") return "bg-red-400";
  if (status === "running") return "bg-amber-400 animate-pulse";
  return "bg-steel-bright";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-slate-600">{label}</dt>
      <dd className="break-all text-right text-slate-300">{value}</dd>
    </div>
  );
}
