"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

export interface QrDepositCardProps {
  address: string;
  token: string;
  symbol: string;
  decimals: number;
  chainId: number;
  suggestedAmount?: string;
}

export function buildPaymentUri(params: {
  token: string;
  chainId: number;
  to: string;
  amountBaseUnits?: string;
}): string {
  const base = `ethereum:${params.token}@${params.chainId}/transfer?address=${params.to}`;
  return params.amountBaseUnits ? `${base}&uint256=${params.amountBaseUnits}` : base;
}

export function toBaseUnits(amount: string, decimals: number): string | null {
  const trimmed = amount.trim();
  if (trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;

  const padded = fraction.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

export function QrDepositCard({
  address,
  token,
  symbol,
  decimals,
  chainId,
  suggestedAmount = "",
}: QrDepositCardProps) {
  const [amount, setAmount] = useState(suggestedAmount);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const amountBaseUnits = useMemo(() => {
    if (amount.trim() === "") return undefined;
    return toBaseUnits(amount, decimals) ?? undefined;
  }, [amount, decimals]);

  const uri = useMemo(
    () => buildPaymentUri({ token, chainId, to: address, amountBaseUnits }),
    [token, chainId, address, amountBaseUnits],
  );

  useEffect(() => {
    let cancelled = false;

    QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#84CC16", light: "#080C14" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [uri]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const invalidAmount = amount.trim() !== "" && amountBaseUnits === undefined;

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between">
        <p className="label-caps">Deposit to burner</p>
        <span className="font-mono text-[10px] uppercase tracking-widest text-lime-dim">{symbol}</span>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="mx-auto shrink-0 rounded-md border border-steel bg-void p-2 sm:mx-0">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt={`QR code to deposit ${symbol} into ${address}`} className="h-40 w-40" />
          ) : (
            <div className="flex h-40 w-40 items-center justify-center font-mono text-[10px] text-slate-600">
              rendering…
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <label className="label-caps" htmlFor="deposit-amount">
            Amount (optional)
          </label>
          <input
            id="deposit-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={`mt-1.5 w-full rounded border bg-void px-2.5 py-1.5 font-mono text-sm text-slate-100 focus:outline-none ${
              invalidAmount ? "border-red-900" : "border-steel focus:border-lime-dim"
            }`}
          />
          {invalidAmount && (
            <p className="mt-1 font-mono text-[10px] text-red-400">
              Use a plain decimal with at most {decimals} places.
            </p>
          )}

          <p className="label-caps mt-3">Burner address</p>
          <button
            type="button"
            onClick={() => copy(address)}
            className="mt-1.5 w-full break-all rounded border border-steel bg-void px-2.5 py-2 text-left font-mono text-[11.5px] text-slate-300 transition-colors hover:border-steel-bright hover:text-lime-glow"
            title="Copy address"
          >
            {address}
          </button>
          <p className="mt-1.5 font-mono text-[10px] text-slate-600">
            {copied ? <span className="text-lime">copied to clipboard</span> : "tap to copy · EIP-681 encoded in QR"}
          </p>
        </div>
      </div>

      <p className="mt-4 border-t border-steel/60 pt-3 text-[12px] leading-relaxed text-slate-500">
        Send <span className="text-slate-300">{symbol}</span> on chain{" "}
        <span className="font-mono text-slate-300">{chainId}</span>. Do not send native gas — the burner does not
        need it, and funding it from your main wallet is the exact link SAPU exists to prevent.
      </p>
    </div>
  );
}
