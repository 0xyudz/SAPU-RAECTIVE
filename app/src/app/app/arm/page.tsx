"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { readDeploymentConfig } from "@/config/chains";
import { POLL_INTERVAL_MS } from "@/config/constants";
import type { RouteIndex } from "@/infrastructure/route-indexer";
import type {
  BalanceResponse,
  HealthResponse,
} from "@/domain/api-responses";
import type { Address } from "@/domain/burner-route";
import { isAddress, toAddress } from "@/domain/burner-route";
import { addressKey, stampRead, visibleRead, type StampedRead } from "@/domain/api-payload";
import { assessKeyRisk } from "@/domain/key-risk";
import { burnerBalanceNotice, type BurnerBalanceRead } from "@/domain/residue";
import { tokenChoices as buildTokenChoices } from "@/domain/token-choices";
import {
  armGate,
  armGateNote,
  authorityGapNote,
  resolveArmAuthority,
} from "@/domain/arm-authority";
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
import { shortAddress } from "@/components/short-value";
import { BurnerRecovery } from "@/components/burner-recovery";
import { useUnsavedKeyGuard } from "@/components/use-unsaved-key-guard";
import { ReadOnlyNote } from "@/components/wallet-button";
import { ErrorNote } from "@/components/primitives";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "../use-write";
import { useWallet } from "../wallet";
import { useBurnerVault } from "./use-burners";
import { useTokenMetadata } from "./use-token-metadata";
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
  // Pulled out as a primitive so the arm callback can depend on a stable value. `config` is
  // rebuilt on every render, so depending on it directly would recreate the callback (and
  // its preflight gate) on each pass.
  const originChainId = config.origin.id;
  // Same reason: `config` is rebuilt every render, so its nested strings are read once here.
  const originName = config.origin.name;
  const [manualBurner, setManualBurner] = useState("");
  const [coldWallet, setColdWallet] = useState("");
  /**
   * `null` means "no operator choice yet, use the deployment default"; `""` means the operator
   * deliberately chose to type an address and has not finished. The two must not collapse:
   * a plain `""` default made the token field fall back to the configured token, so selecting
   * "Other ERC-20" in the picker snapped straight back to the default on the next render.
   */
  const [tokenInput, setTokenInput] = useState<string | null>(null);
  /**
   * Both of these are stamped with the inputs they were produced for, not stored bare.
   *
   * The Arm page reads `routeOf`/`ruleOf`/`allowance` for one (rsc, forwarder, burner, token)
   * tuple, and reports the result of arming one (burner, token, cold wallet) tuple. Stored as
   * plain state, both outlived their inputs: switching the burner field left the previous
   * burner's "route.active true · allowance unlimited" panel on screen under the new address,
   * and left the pipeline header reading "armed" for a route that had never been armed.
   * `visibleRead` hides a value whose key does not match, so a stale read is absent rather
   * than mislabelled — the same rule `visiblePayload` applies to polled urls.
   */
  const [snapshot, setSnapshot] = useState<StampedRead<ArmingSnapshot> | null>(null);
  const [outcome, setOutcome] = useState<StampedRead<ArmingOutcome> | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ArmActionKey | null>(null);

  const health = useApi<HealthResponse>("/api/health", POLL_INTERVAL_MS.health);
  const routes = useApi<RouteIndex>("/api/routes", POLL_INTERVAL_MS.routes);
  const { wallet, connect } = useWallet();
  const gate = useWriteGate();

  const verified = routes.data?.verified === true;
  const rsc = verified ? (routes.data?.rsc ?? null) : null;
  const forwarder = verified ? (routes.data?.forwarder ?? null) : null;
  const effectiveToken = tokenInput ?? (verified ? (routes.data?.token ?? "") : "");

  const activeBurner: Address | null = asAddressOrNull(manualBurner) ?? vault.selected;

  const walletAddress = wallet.address?.toLowerCase() ?? null;
  // Owner authority is resolved per step, not as one flag. The steps write to two different
  // contracts, and a deployment may have a different key for each — the live testnet stack
  // does. Requiring one wallet to own both made the Arm button unreachable for every operator.
  const authority = resolveArmAuthority(walletAddress as Address | null, {
    rscOwner: routes.data?.rscOwner ?? null,
    forwarderOwner: routes.data?.forwarderOwner ?? null,
  });
  const authorityNote = authorityGapNote(authority, walletAddress as Address | null);

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

  /**
   * Metadata for the token **in the form**, not for the configured one. See
   * `use-token-metadata.ts` for why this is keyed to the typed address and polled separately
   * from the balance.
   */
  const tokenMetadata = useTokenMetadata(tokenAddress, originName);
  const { symbol: tokenSymbol, decimals: tokenDecimals } = tokenMetadata;

  /**
   * The token picker's options, derived from what the registry read off the chain.
   *
   * Not a hardcoded list: a built-in USDC/WETH table would be a fixture, and it would name the
   * wrong addresses on every chain but the one it was copied from. The registry already knows
   * which tokens this deployment routes and what each one's `symbol()`/`decimals()` are, so the
   * list comes from there and the configured token is only the seed.
   */
  const tokenChoices = useMemo(
    () =>
      buildTokenChoices(
        (routes.data?.rows ?? []).map((row) => ({
          token: row.token,
          tokenSymbol: row.tokenSymbol,
          tokenDecimals: row.tokenDecimals,
        })),
        routes.data?.token ?? null,
      ),
    [routes.data?.rows, routes.data?.token],
  );

  const holdsKey = activeBurner !== null && vault.hasKeyFor(activeBurner);

  const keyFor = vault.keyFor;

  /**
   * The exact chain state `inspect()` answers about: which RSC, which forwarder, which burner,
   * which token. `addressKey` returns null while any of them is missing, which makes every
   * read invisible until the form names a complete target.
   */
  const snapshotKey = addressKey([rsc, forwarder, activeBurner, tokenAddress]);

  /**
   * The tuple an arm result is a claim about.
   *
   * It includes the cold wallet, so editing the destination after a run hides the previous
   * "armed" verdict rather than letting it stand for a route with a different destination.
   */
  const outcomeKey = addressKey([forwarder, activeBurner, tokenAddress, coldWalletAddress]);

  const readSnapshot = useCallback(async (): Promise<StampedRead<ArmingSnapshot> | null> => {
    if (
      snapshotKey === null ||
      activeBurner === null ||
      rsc === null ||
      forwarder === null ||
      tokenAddress === null
    ) {
      return null;
    }
    const value = await createArmWriter({ burnerPrivateKey: keyFor(activeBurner) }).inspect({
      rsc,
      forwarder,
      burner: activeBurner,
      token: tokenAddress,
    });
    // Stamped with the key this read was *started* for, not with whatever the form holds when
    // it lands. A slow read that finishes after the operator switched burners must be stored
    // under the burner it actually describes, so `visibleRead` can tell the two apart.
    return stampRead(snapshotKey, value);
  }, [activeBurner, forwarder, keyFor, rsc, snapshotKey, tokenAddress]);

  const inspect = useCallback(async () => {
    if (snapshotKey === null) return;
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
  }, [readSnapshot, snapshotKey]);

  useEffect(() => {
    if (snapshotKey === null) return;
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
  }, [readSnapshot, snapshotKey]);

  // Both are filtered against the current inputs, so neither can outlive the form state it
  // was read for. This is the whole fix: the panel and the pipeline label are derived from
  // `visibleRead`, not from raw state.
  const effectiveSnapshot = visibleRead(snapshot, snapshotKey);
  const effectiveOutcome = visibleRead(outcome, outcomeKey);

  // The key is the only copy of the burner, so a reload while it is armed or funded would
  // destroy something an address alone cannot rebuild. The rule lives in `domain/key-risk.ts`
  // so "unknown balance" cannot quietly become "safe to lose" in the view layer.
  const keyRisk = assessKeyRisk({
    holdsKey,
    armed: effectiveSnapshot?.routeActive === true && effectiveSnapshot.ruleArmed,
    balance: liveBalance.data?.balance ?? null,
  });
  useUnsavedKeyGuard(keyRisk.atRisk);

  // The pipeline is derived from the same stamped values, so a stale snapshot cannot feed it.
  const displaySteps: readonly ArmStepState[] = useMemo(
    () =>
      effectiveOutcome?.steps ??
      (effectiveSnapshot !== null && forwarder !== null
        ? deriveArmSteps(effectiveSnapshot, { forwarder, coldWallet: coldWalletAddress })
        : emptyArmSteps()),
    [effectiveOutcome, effectiveSnapshot, forwarder, coldWalletAddress],
  );

  /**
   * What pressing "Arm route" would actually do.
   *
   * `null` steps means the chain state for this burner/token has not been read yet — the gate
   * cannot know which step comes first, and says so instead of guessing. Enabling the button on
   * "some step is signable" is not the same question: for a forwarder-only owner it would enable
   * a run whose very first transaction (`setForwarder`, an RSC owner call) reverts.
   */
  const gateVerdict = armGate(effectiveSnapshot === null ? null : displaySteps, authority);
  const gateNote = armGateNote(gateVerdict);
  const canArm = gateVerdict.kind === "ready";

  const run = useCallback(async () => {
    setLocalError(null);
    setOutcome(null);
    gate.reset();

    if (!verified || rsc === null || forwarder === null) {
      setLocalError(routes.data?.error ?? "Contracts are not configured and verified with eth_getCode.");
      return;
    }
    if (!canArm) {
      setLocalError(gateNote ?? authorityNote ?? "This wallet cannot sign the next arming step.");
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
    if (tokenSymbol === null || tokenDecimals === null) {
      setLocalError(
        "The token in the form has no readable symbol()/decimals() yet. Arming with guessed metadata would record a route the chain does not describe.",
      );
      return;
    }
    // The key the result will be filed under. Captured before the first await, so a form edit
    // made while the run is in flight cannot relabel the verdict.
    if (outcomeKey === null) return;

    const input: RegisterInput = {
      rsc,
      forwarder,
      burner: activeBurner,
      coldWallet: coldWalletAddress,
      token: tokenAddress,
      tokenSymbol,
      tokenDecimals,
      chainId: originChainId,
    };

    setBusy("arm");
    try {
      const writer = createArmWriter({ burnerPrivateKey: keyFor(activeBurner) });
      setOutcome(stampRead(outcomeKey, await armRoute(writer, input, gate.options)));
      routes.refresh();
      void inspect();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [
    activeBurner,
    authorityNote,
    canArm,
    coldWalletAddress,
    forwarder,
    gate,
    gateNote,
    inspect,
    keyFor,
    originChainId,
    outcomeKey,
    rsc,
    routes,
    tokenAddress,
    tokenDecimals,
    tokenSymbol,
    verified,
  ]);

  const divergence =
    effectiveOutcome !== null && !effectiveOutcome.ok ? effectiveOutcome.divergence : undefined;

  const pipelineLabel = effectiveOutcome?.ok
    ? "armed"
    : effectiveOutcome
      ? "stopped"
      : "not started";

  const burnerNote =
    activeBurner === null
      ? "no burner selected"
      : vault.hasKeyFor(activeBurner)
        ? "ephemeral key in tab · permit, or a burner-signed approve for tokens without one"
        : "no key in tab · can inspect/resume if the allowance already exists";

  // The hint describes the token in the form, and it comes from the same read the arm guard
  // uses, so the label and the decision cannot disagree about which asset is being recorded.
  const tokenHint = tokenMetadata.notice.note;

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
          detail={
            routes.error ??
            (authorityNote === null ? "owner wallet connected" : "owner signature required")
          }
        />
      </header>

      {(localError ?? health.error ?? routes.error) && (
        <ErrorNote>{localError ?? health.error ?? routes.error}</ErrorNote>
      )}

      {/* Non-fatal configuration notes. Today: the default token is unusable. It must not be an
          ErrorNote — the app still arms and sweeps any ERC-20 — but it must be visible, because
          the form pre-fills that address. */}
      {(health.data?.warnings ?? []).map((warning) => (
        <p key={warning} className="font-mono text-[10.5px] leading-relaxed text-amber-500">
          {warning}
        </p>
      ))}

      {!wallet.connected ? (
        <ReadOnlyNote>
          <button type="button" onClick={connect} className="text-lime-glow hover:underline">
            connect wallet
          </button>{" "}
          to sign the arming transactions
        </ReadOnlyNote>
      ) : authorityNote !== null ? (
        <ReadOnlyNote>{authorityNote}</ReadOnlyNote>
      ) : gateNote !== null ? (
        // The gate note names the *step* that is stuck, which `authorityNote` cannot: the wallet
        // may own both contracts and still have nothing to do, or the chain may disagree with the
        // form. Shown instead of the authority note because it is the more specific fact.
        <ReadOnlyNote>{gateNote}</ReadOnlyNote>
      ) : null}

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} />
      <FailureReport
        reason={gate.failure?.reason ?? null}
        decoded={gate.failure?.decoded}
        onClear={gate.clearFailure}
      />

      {divergence && <DivergencePanel divergence={divergence} />}

      <p className="max-w-3xl text-[12px] leading-relaxed text-slate-600">
        Step 3 grants the forwarder an allowance. For tokens that implement EIP-2612 the burner signs a
        permit off-chain and pays nothing. A token with no permit falls back to a plain{" "}
        <code className="font-mono text-slate-500">approve</code> signed by the burner, which requires native
        gas in the burner — the one flow where SAPU asks the burner to pay. If no burner key is loaded, that
        fallback is unavailable and arming stops before sending anything.
      </p>

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
          tokenChoices={tokenChoices}
          tokenChoicesReady={!routes.loading}
          tokenHint={tokenHint}
          canInspect={canInspect}
          canArm={canArm && activeBurner !== null && verified && tokenMetadata.armable}
          busy={busy}
          phase={gate.phase}
          onInspect={() => void inspect()}
          onArm={() => void run()}
        >
          {effectiveSnapshot && <ArmSnapshotPanel snapshot={effectiveSnapshot} />}
        </ArmControls>

        <div className="space-y-4">
          <ArmPipeline
            steps={displaySteps}
            outcomeLabel={pipelineLabel}
            armed={effectiveOutcome?.ok === true}
            authority={authority}
          />
          <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />
          {activeBurner !== null && tokenAddress !== null && (
            <QrDepositCard
              address={activeBurner}
              token={tokenAddress}
              // A token whose `symbol()` could not be read still has a deposit address that
              // works: the EIP-681 URI is built from the token address, not from the ticker.
              // Hiding the card in that case removed the only way to fund a burner exactly when
              // the node was rate-limiting — the worst moment to take the funding path away.
              // So the card stays, labelled by address, and says why it has no ticker.
              symbol={tokenMetadata.symbol ?? shortAddress(tokenAddress)}
              decimals={tokenMetadata.decimals}
              unreadable={tokenMetadata.symbol === null}
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
