"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

export interface QrDepositCardProps {
  address: string;
  token: string;
  symbol: string;
  /**
   * `decimals()` as read from the token contract, or null when it could not be read.
   *
   * Null disables the amount field instead of substituting a scale. The QR without an amount is
   * still a valid deposit instruction — it simply asks the sender to choose — while a QR that
   * encodes `amount × 10^18` for a 6-decimal token would instruct a transfer a trillion times
   * too large, which the wallet would either reject or, worse, send.
   */
  decimals: number | null;
  chainId: number;
  suggestedAmount?: string;
  /**
   * Set when `symbol()` could not be read from the token contract.
   *
   * The card is still rendered in that case, because the deposit itself does not depend on the
   * ticker: the EIP-681 URI is built from the token address. Only the label changes, so the
   * operator sees why the card shows an address instead of a ticker — hiding the card would
   * remove the funding path precisely when the node is misbehaving.
   */
  unreadable?: boolean;
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
  unreadable = false,
}: QrDepositCardProps) {
  const [amount, setAmount] = useState(suggestedAmount);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const amountBaseUnits = useMemo(() => {
    if (decimals === null || amount.trim() === "") return undefined;
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
            disabled={decimals === null}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={decimals === null ? "decimals unreadable" : undefined}
            className={`mt-1.5 w-full rounded border bg-void px-2.5 py-1.5 font-mono text-sm text-slate-100 focus:outline-none disabled:opacity-50 ${
              invalidAmount ? "border-red-900" : "border-steel focus:border-lime-dim"
            }`}
          />
          {invalidAmount && (
            <p className="mt-1 font-mono text-[10px] text-red-400">
              Use a plain decimal with at most {decimals} places.
            </p>
          )}
          {decimals === null && (
            <p className="mt-1 font-mono text-[10px] text-amber-500">
              decimals() could not be read, so no amount is encoded — the QR asks the sender to
              choose. Guessing a scale here would encode the wrong number of base units.
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
      {unreadable && (
        <p className="mt-2 border-t border-amber-900/40 pt-2 font-mono text-[10px] leading-relaxed text-amber-500">
          symbol() could not be read, so this card labels the token by address. The QR is still
          correct — it encodes the token contract above — but check the address before sending.
        </p>
      )}
    </div>
  );
}
