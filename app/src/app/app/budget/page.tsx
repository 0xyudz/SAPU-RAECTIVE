"use client";


import { useState } from "react";
import type { Address } from "@/domain/burner-route";
import { formatReceiptUnits } from "@/domain/tx-receipt";
import { applyBudgetAction, type BudgetAction, type BudgetSnapshot } from "@/application/budget-controls";
import { createBudgetWriter } from "@/infrastructure/budget-writer";
import { LiveBadge } from "@/components/live-badge";
import { FailureReport, PhasePill, ProofDrawer } from "@/components/proof-drawer";
import { PreflightPanel } from "@/components/preflight-panel";
import { ReadOnlyNote } from "@/components/wallet-button";
import { useApi } from "@/components/use-api";
import { useWriteGate } from "../use-write";
import { useWallet } from "../wallet";

interface BudgetView {
  callbackGasLimit: string;
  rscBalance: string;
  forwarderBalance: string;
  gasPrice: string;
  rscDebt: string;
  forwarderDebt: string;
  sweepsRemaining: string;
  costPerSweepWei: string;
}

interface BudgetResponse {
  configured: boolean;
  verified: boolean;
  error?: string;
  budget?: BudgetView;
  owners?: { rsc: Address | null; forwarder: Address | null };
  checkedAt?: string;
}

function eth(wei: string): string {
  return `${formatReceiptUnits(BigInt(wei), 18)} ETH`;
}

function lreact(wei: string): string {
  return `${formatReceiptUnits(BigInt(wei), 18)} lREACT`;
}

export default function BudgetPage() {
  const budget = useApi<BudgetResponse>("/api/budget", 15_000);
  const { wallet, connect } = useWallet();
  const gate = useWriteGate();
  const [gasLimitInput, setGasLimitInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const view = budget.data?.budget ?? null;
  const owners = budget.data?.owners;
  const walletAddress = wallet.address?.toLowerCase() ?? null;
  const isRscOwner = walletAddress !== null && walletAddress === owners?.rsc;

  const snapshot: BudgetSnapshot | null = view
    ? {
        callbackGasLimit: BigInt(view.callbackGasLimit),
        rscBalance: BigInt(view.rscBalance),
        forwarderBalance: BigInt(view.forwarderBalance),
        gasPrice: BigInt(view.gasPrice),
        rscDebt: BigInt(view.rscDebt),
        forwarderDebt: BigInt(view.forwarderDebt),
      }
    : null;

  const run = async (action: BudgetAction, key: string) => {
    if (snapshot === null) return;
    gate.reset();
    setBusy(key);
    await applyBudgetAction(createBudgetWriter(), action, snapshot, gate.options);
    setBusy(null);
    budget.refresh();
  };

  const sweeps = view === null ? null : BigInt(view.sweepsRemaining);
  const bothDebtsZero = view !== null && BigInt(view.rscDebt) === 0n && BigInt(view.forwarderDebt) === 0n;
  const gasLimitValid = /^\d+$/.test(gasLimitInput) && BigInt(gasLimitInput) > 0n;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-50">Callback Budget</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            How many sweeps the destination budget can pay for at the current gas limit, plus the two debts that stop
            callbacks without a revert.
          </p>
        </div>
        <LiveBadge
          state={
            budget.data === null
              ? "offline"
              : !budget.data.configured
                ? "unconfigured"
                : budget.data.verified
                  ? "live"
                  : "degraded"
          }
          detail={budget.error ?? (view ? `gas price ${view.gasPrice} wei` : "waiting")}
        />
      </header>

      {(budget.error ?? budget.data?.error) && (
        <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 font-mono text-[11px] text-amber-500">
          {budget.error ?? budget.data?.error}
        </p>
      )}

      <PreflightPanel diff={gate.diff} onApprove={gate.approve} onReject={gate.reject} busy={busy !== null} />
      <FailureReport reason={gate.failure?.reason ?? null} decoded={gate.failure?.decoded} onClear={gate.clearFailure} />
      <ProofDrawer receipts={gate.receipts} onClear={gate.reset} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <BigStat
          label="sweeps remaining"
          value={sweeps === null ? "—" : sweeps.toString()}
          detail="upper bound at the current limit"
          tone={sweeps !== null && sweeps === 0n ? "danger" : "normal"}
        />
        <BigStat
          label="cost per sweep"
          value={view === null ? "—" : eth(view.costPerSweepWei)}
          detail="gasLimit × gasPrice"
        />
        <BigStat
          label="forwarder balance"
          value={view === null ? "—" : eth(view.forwarderBalance)}
          detail="Base Sepolia · pays callbacks"
        />
        <BigStat
          label="RSC balance"
          value={view === null ? "—" : lreact(view.rscBalance)}
          detail="Reactive Lasna · pays reactions"
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <p className="label-caps">Debt</p>
          <dl className="mt-3 space-y-2 font-mono text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">SapuRSC · system contract</dt>
              <dd className={view && BigInt(view.rscDebt) > 0n ? "text-red-300" : "text-slate-300"}>
                {view === null ? "—" : lreact(view.rscDebt)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">SapuForwarder · callback proxy</dt>
              <dd className={view && BigInt(view.forwarderDebt) > 0n ? "text-red-300" : "text-slate-300"}>
                {view === null ? "—" : eth(view.forwarderDebt)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-slate-500">
            A contract in debt receives no callbacks. `coverDebt` is permissionless on both contracts, so anyone can
            settle it; the button below is the same call a manual `cast send` would make.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {!wallet.connected ? (
              <ReadOnlyNote>
                <button type="button" onClick={connect} className="text-lime-glow hover:underline">
                  connect wallet
                </button>{" "}
                to send coverDebt
              </ReadOnlyNote>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void run({ kind: "cover-debt", contract: "rsc" }, "cover-rsc")}
                  disabled={busy !== null || view === null}
                  className="rounded border border-steel px-3 py-1.5 font-mono text-[10.5px] text-slate-300 transition-colors hover:border-steel-bright disabled:opacity-50"
                >
                  {busy === "cover-rsc" ? "working…" : "cover RSC debt"}
                </button>
                <button
                  type="button"
                  onClick={() => void run({ kind: "cover-debt", contract: "forwarder" }, "cover-forwarder")}
                  disabled={busy !== null || view === null}
                  className="rounded border border-steel px-3 py-1.5 font-mono text-[10.5px] text-slate-300 transition-colors hover:border-steel-bright disabled:opacity-50"
                >
                  {busy === "cover-forwarder" ? "working…" : "cover forwarder debt"}
                </button>
              </>
            )}
          </div>
          {bothDebtsZero && (
            <p className="mt-2 font-mono text-[10px] text-lime-dim">both debts are zero — the loop is payable.</p>
          )}
        </div>

        <div className="panel p-5">
          <p className="label-caps">Gas limit</p>
          <p className="mt-2 font-mono text-2xl text-slate-100">
            {view?.callbackGasLimit ?? "—"}
            <span className="ml-2 text-[11px] text-slate-600">gas per callback</span>
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
            The callback proxy charges its own overhead on top of the limit. If sweeps fail with out-of-gas while the
            budget is positive, raising this value is the fix. It is owner-only on SapuRSC.
          </p>

          <label className="label-caps mt-4 block" htmlFor="gas-limit">
            New gas limit
          </label>
          <input
            id="gas-limit"
            value={gasLimitInput}
            onChange={(event) => setGasLimitInput(event.target.value)}
            inputMode="numeric"
            spellCheck={false}
            className="mt-1.5 w-full rounded border border-steel bg-void px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-lime-dim focus:outline-none"
          />

          <div className="mt-3">
            {!wallet.connected ? (
              <ReadOnlyNote>
                <button type="button" onClick={connect} className="text-lime-glow hover:underline">
                  connect wallet
                </button>{" "}
                to sign an owner action
              </ReadOnlyNote>
            ) : !isRscOwner ? (
              <ReadOnlyNote>owner only — this wallet is not the RSC owner</ReadOnlyNote>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void run({ kind: "set-gas-limit", gasLimit: BigInt(gasLimitInput) }, "set-gas-limit")
                }
                disabled={!gasLimitValid || busy !== null || view === null}
                className="rounded-md bg-lime px-4 py-2 font-mono text-[11.5px] font-semibold text-void transition-colors hover:bg-lime-glow disabled:cursor-not-allowed disabled:bg-steel disabled:text-slate-600"
              >
                {busy === "set-gas-limit" ? "working…" : "Set gas limit"}
              </button>
            )}
          </div>
          {gate.phase !== "idle" && (
            <div className="mt-3">
              <PhasePill phase={gate.phase} />
            </div>
          )}
        </div>
      </section>

      <section className="panel p-5">
        <p className="label-caps">Why a route goes silent</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Silence
            title="No lREACT on the reactive side"
            body="SapuRSC pays the system contract for each reaction from its own balance. At zero it is skipped silently: no callback, no revert, no event. The RSC balance above is the reserve, not the deposit."
          />
          <Silence
            title="No ETH on the destination side"
            body="The callback proxy bills the forwarder for the callback. When the forwarder cannot pay, the sweep does not happen. The sweep count above is computed from that balance, the real limit, and the current gas price."
          />
          <Silence
            title="Outstanding debt"
            body="Both contracts implement IPayable. A non-zero debt blocks callbacks until it is settled. `coverDebt` exists precisely because the failure is otherwise unobservable."
          />
          <Silence
            title="Gas limit too low"
            body="A limit below what the forwarder needs produces a failed callback rather than a failed sweep. Raising the limit is the owner action on the left; it changes future callbacks, not past ones."
          />
        </div>
      </section>
    </div>
  );
}

function BigStat({
  label,
  value,
  detail,
  tone = "normal",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "normal" | "danger";
}) {
  return (
    <div className="panel px-4 py-4">
      <p className="label-caps">{label}</p>
      <p className={`mt-1 font-mono text-xl ${tone === "danger" ? "text-red-300" : "text-slate-100"}`}>{value}</p>
      <p className="mt-1 text-[10.5px] text-slate-600">{detail}</p>
    </div>
  );
}

function Silence({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded border border-steel/70 p-3">
      <h3 className="font-mono text-[11.5px] text-slate-200">{title}</h3>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}
