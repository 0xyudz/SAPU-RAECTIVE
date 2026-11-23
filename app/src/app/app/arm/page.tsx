"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readDeploymentConfig } from "@/config/chains";
import { POLL_INTERVAL_MS } from "@/config/constants";
import type { RouteIndex } from "@/infrastructure/route-indexer";
import type { BalanceResponse, HealthResponse } from "@/domain/api-responses";
import type { Address } from "@/domain/burner-route";
import { isAddress, toAddress } from "@/domain/burner-route";
import { assessKeyRisk } from "@/domain/key-risk";
import { burnerBalanceNotice, type BurnerBalanceRead } from "@/domain/residue";
import {
  armRoute,
  deriveArmSteps,
  emptyArmSteps,
  type ArmStepState,
  type ArmingOutcome,
  type ArmingSnapshot,
  type RegisterInput,
} from "@/application/registration-service";
import { createArmWriter } from "@/infrastructure/arm-writer";
import { LiveBadge, probeState } from "@/components/live-badge";
import { FailureReport, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { QrDepositCard } from "@/components/qr-deposit-card";
import { BurnerRecovery } from "@/components/burner-recovery";
import { useUnsavedKeyGuard } from "@/components/use-unsaved-key-guard";
import { ReadOnlyNote } from "@/components/wallet-button";
import { ErrorNote } from "@/components/primitives";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "../use-write";
import { useWallet } from "../wallet";
import { useBurnerVault } from "./use-burners";
import { ArmControls, type ArmActionKey } from "./arm-controls";
import { ArmPipeline } from "./arm-pipeline";
import { ArmSnapshotPanel, DivergencePanel } from "./arm-snapshot-panel";

function asAddressOrNull(value: string): Address | null {
  return isAddress(value) ? toAddress(value) : null;
}

export default function ArmPage() {
  const vault = useBurnerVault();
  // Chain identity for the deposit QR and the burner panel comes from the deployment
  // config, so arming a burner on any Reactive-supported chain needs no code change.
  const config = readDeploymentConfig();
  const [manualBurner, setManualBurner] = useState("");
  const [coldWallet, setColdWallet] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [snapshot, setSnapshot] = useState<ArmingSnapshot | null>(null);
  const [outcome, setOutcome] = useState<ArmingOutcome | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ArmActionKey | null>(null);

  const health = useApi<HealthResponse>("/api/health", POLL_INTERVAL_MS.health);
  const routes = useApi<RouteIndex>("/api/routes", POLL_INTERVAL_MS.routes);
  const { wallet, connect } = useWallet();
  const gate = useWriteGate();

  const verified = routes.data?.verified === true;
  const rsc = verified ? (routes.data?.rsc ?? null) : null;
  const forwarder = verified ? (routes.data?.forwarder ?? null) : null;
  const effectiveToken = tokenInput || (verified ? (routes.data?.token ?? "") : "");

  const activeBurner: Address | null = asAddressOrNull(manualBurner) ?? vault.selected;

  const tokenMetadata = health.data?.token ?? null;

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isOwner =
    walletAddress !== null &&
    walletAddress === routes.data?.rscOwner &&
    walletAddress === routes.data?.forwarderOwner;

  const coldWalletAddress = asAddressOrNull(coldWallet);
  const tokenAddress = asAddressOrNull(effectiveToken);

  const canInspect = activeBurner !== null && rsc !== null && forwarder !== null && tokenAddress !== null;

  // The balance that matters for key safety: the selected burner's live token balance, read
  // straight from the chain. Deliberately not taken from `/api/ledger`, which only knows
  // burners that already appear in the registry or in a sweep log — a burner funded through
  // the QR card but never armed is invisible there, and that is precisely the burner whose
  // key is most costly to lose, because nothing on-chain will ever move its balance out.
  const liveBalance = useApi<BalanceResponse>(
    activeBurner === null || tokenAddress === null
      ? null
      : `/api/balance?burner=${activeBurner}&token=${tokenAddress}`,
    POLL_INTERVAL_MS.ledger,
  );

  const holdsKey = activeBurner !== null && vault.hasKeyFor(activeBurner);

  const keyFor = vault.keyFor;

  const readSnapshot = useCallback(async (): Promise<ArmingSnapshot | null> => {
    if (activeBurner === null || rsc === null || forwarder === null || tokenAddress === null) return null;
    return createArmWriter({ burnerPrivateKey: keyFor(activeBurner) }).inspect({
      rsc,
      forwarder,
      burner: activeBurner,
      token: tokenAddress,
    });
  }, [activeBurner, forwarder, keyFor, rsc, tokenAddress]);

  const inspect = useCallback(async () => {
    if (!canInspect) return;
    setLocalError(null);
    setBusy("inspect");
    try {
      setSnapshot(await readSnapshot());
    } catch (error) {
      setSnapshot(null);
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [canInspect, readSnapshot]);

  useEffect(() => {
    if (!canInspect) return;
    let cancelled = false;
    void readSnapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSnapshot(null);
        setLocalError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [canInspect, readSnapshot]);

  const effectiveSnapshot = canInspect ? snapshot : null;

  // The key is the only copy of the burner, so a reload while it is armed or funded would
  // destroy something an address alone cannot rebuild. The rule lives in `domain/key-risk.ts`
  // so "unknown balance" cannot quietly become "safe to lose" in the view layer.
  const keyRisk = assessKeyRisk({
    holdsKey,
    armed: effectiveSnapshot?.routeActive === true && effectiveSnapshot.ruleArmed,
    balance: liveBalance.data?.balance ?? null,
  });
  useUnsavedKeyGuard(keyRisk.atRisk);

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
    if (tokenAddress === null || coldWalletAddress === null) {
      setLocalError("Token and cold wallet must be full 0x addresses.");
      return;
    }
    if (tokenMetadata === null) {
      setLocalError(
        "Token symbol and decimals have not been read from the contract yet. Arming with guessed metadata would record a route the chain does not describe.",
      );
      return;
    }

    const input: RegisterInput = {
      rsc,
      forwarder,
      burner: activeBurner,
      coldWallet: coldWalletAddress,
      token: tokenAddress,
      tokenSymbol: tokenMetadata.symbol,
      tokenDecimals: tokenMetadata.decimals,
      chainId: config.origin.id,
    };

    setBusy("arm");
    try {
      const writer = createArmWriter({ burnerPrivateKey: keyFor(activeBurner) });
      setOutcome(await armRoute(writer, input, gate.options));
      routes.refresh();
      void inspect();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [
    activeBurner,
    coldWalletAddress,
    forwarder,
    gate,
    inspect,
    isOwner,
    keyFor,
    rsc,
    routes,
    tokenAddress,
    tokenMetadata,
    verified,
    wallet.connected,
  ]);

  const divergence = outcome !== null && !outcome.ok ? outcome.divergence : undefined;

  const displaySteps: readonly ArmStepState[] = useMemo(
    () =>
      outcome?.steps ??
      (effectiveSnapshot !== null && forwarder !== null
        ? deriveArmSteps(effectiveSnapshot, { forwarder, coldWallet: coldWalletAddress })
        : emptyArmSteps()),
    [outcome, effectiveSnapshot, forwarder, coldWalletAddress],
  );

  const pipelineLabel = outcome?.ok ? "armed" : outcome ? "stopped" : "not started";

  const burnerNote =
    activeBurner === null
      ? "no burner selected"
      : vault.hasKeyFor(activeBurner)
        ? "ephemeral key in tab · EIP-2612 armWithPermit ready"
        : "no key in tab · can inspect/resume if allowance already exists";

  const tokenHint =
    tokenMetadata === null
      ? "metadata not read yet · arm is blocked until the contract answers symbol()/decimals()"
      : `${tokenMetadata.symbol} · ${tokenMetadata.decimals} decimals · ${config.origin.name}`;

  // Shown next to the burner so the operator sees money in a key-only wallet *before*
  // reloading, not after. An unread balance is never rendered as "empty": zero is a claim
  // about the chain, and a failed read is not. The wording *and* the colour both come from
  // `burnerBalanceNotice` so the two cannot drift apart.
  const balanceRead: BurnerBalanceRead =
    activeBurner === null
      ? { kind: "no-burner" }
      : tokenAddress === null
        ? { kind: "no-token" }
        : liveBalance.data === null
          ? liveBalance.error === null
            ? { kind: "pending" }
            : { kind: "failed", reason: liveBalance.error }
          : liveBalance.data.balance === null
            ? { kind: "unread" }
            : { kind: "read", balance: liveBalance.data.balance };

  const balanceNotice = burnerBalanceNotice(balanceRead);

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
          state={probeState(routes.data, routes.error, routes.loading)}
          detail={routes.error ?? (isOwner ? "owner wallet connected" : "owner signature required")}
        />
      </header>

      {(localError ?? health.error ?? routes.error) && (
        <ErrorNote>{localError ?? health.error ?? routes.error}</ErrorNote>
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

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} busy={busy !== null} />
      <FailureReport
        reason={gate.failure?.reason ?? null}
        decoded={gate.failure?.decoded}
        onClear={gate.clearFailure}
      />

      {divergence && <DivergencePanel divergence={divergence} />}

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <ArmControls
          mounted={vault.mounted}
          burners={vault.burners}
          selected={vault.selected}
          onSelect={(address) => {
            setManualBurner("");
            vault.select(address);
          }}
          onCreate={() => {
            vault.create();
            setManualBurner("");
          }}
          onForget={vault.forget}
          onPurge={vault.purge}
          manualBurner={manualBurner}
          onManualBurner={setManualBurner}
          burnerNote={burnerNote}
          residueNote={balanceNotice.note}
          residueTone={balanceNotice.tone}
          coldWallet={coldWallet}
          onColdWallet={setColdWallet}
          token={effectiveToken}
          onToken={setTokenInput}
          tokenHint={tokenHint}
          canInspect={canInspect}
          canArm={isOwner && activeBurner !== null && verified && tokenMetadata !== null}
          busy={busy}
          phase={gate.phase}
          onInspect={() => void inspect()}
          onArm={() => void run()}
        >
          {effectiveSnapshot && <ArmSnapshotPanel snapshot={effectiveSnapshot} />}
        </ArmControls>

        <div className="space-y-4">
          <ArmPipeline steps={displaySteps} outcomeLabel={pipelineLabel} armed={outcome?.ok === true} />
          <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />
          {activeBurner !== null && tokenAddress !== null && tokenMetadata !== null && (
            <QrDepositCard
              address={activeBurner}
              token={tokenAddress}
              symbol={tokenMetadata.symbol}
              decimals={tokenMetadata.decimals}
              chainId={config.origin.id}
            />
          )}

          <BurnerRecovery
            selected={activeBurner}
            hasKey={holdsKey}
            privateKey={activeBurner === null ? null : vault.keyFor(activeBurner)}
            chainId={config.origin.id}
            onDerive={async (index) => {
              // Clear the manual override first: `activeBurner` prefers a pasted address, so a
              // derived burner would otherwise be stored in the vault but never selected.
              setManualBurner("");
              await vault.derive(index);
            }}
            onAdopt={(key, address) => {
              setManualBurner("");
              vault.adopt({ privateKey: key, address });
            }}
            onExport={(json, fileName) => {
              // Blob download: the key never touches the network or any storage API.
              const blob = new Blob([json], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = fileName;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
            onError={(message) => setLocalError(message)}
          />
        </div>
      </div>
    </div>
  );
}
