"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ConfirmGate, WriteOptions, WriteProgressEvent } from "@/application/ports";
import type { DecodedCallError, PreflightDiff, TxReceipt, WritePhase } from "@/domain/tx-receipt";
import { useWallet } from "./wallet";

export interface FailureState {
  readonly reason: string;
  readonly decoded?: DecodedCallError;
}

export interface WriteGate {
  readonly phase: WritePhase;
  readonly diff: PreflightDiff | null;
  readonly receipts: readonly TxReceipt[];
  readonly failure: FailureState | null;
  readonly options: WriteOptions;
  readonly approve: () => void;
  readonly reject: () => void;
  readonly reset: () => void;
  readonly clearFailure: () => void;
}

export function useWriteGate(): WriteGate {
  const { addSessionReceipt } = useWallet();
  const [phase, setPhase] = useState<WritePhase>("idle");
  const [diff, setDiff] = useState<PreflightDiff | null>(null);
  const [receipts, setReceipts] = useState<TxReceipt[]>([]);
  const [failure, setFailure] = useState<FailureState | null>(null);
  const resolver = useRef<((approved: boolean) => void) | null>(null);

  const appendReceipt = useCallback(
    (receipt: TxReceipt) => {
      addSessionReceipt(receipt);
      setReceipts((current) =>
        current.some((item) => item.chainId === receipt.chainId && item.hash === receipt.hash)
          ? current
          : [...current, receipt],
      );
    },
    [addSessionReceipt],
  );

  const onEvent = useCallback(
    (event: WriteProgressEvent) => {
      if (event.type === "simulating") {
        setPhase("simulating");
        setFailure(null);
      } else if (event.type === "signing") {
        setPhase("signing");
      } else if (event.type === "pending") {
        setPhase("pending");
      } else if (event.type === "confirmed") {
        setPhase("confirmed");
        appendReceipt(event.receipt);
      } else {
        setPhase("failed");
        setFailure({ reason: event.reason, decoded: event.decoded });
        if (event.receipt) {
          appendReceipt(event.receipt);
        }
      }
    },
    [appendReceipt],
  );

  const confirm = useCallback<ConfirmGate>(
    (nextDiff) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setDiff(nextDiff);
        setPhase("simulating");
      }),
    [],
  );

  const approve = useCallback(() => {
    const resolve = resolver.current;
    resolver.current = null;
    setDiff(null);
    resolve?.(true);
  }, []);

  const reject = useCallback(() => {
    const resolve = resolver.current;
    resolver.current = null;
    setDiff(null);
    setPhase("idle");
    resolve?.(false);
  }, []);

  const reset = useCallback(() => {
    resolver.current = null;
    setDiff(null);
    setPhase("idle");
    setReceipts([]);
    setFailure(null);
  }, []);

  const clearFailure = useCallback(() => setFailure(null), []);

  const options = useMemo<WriteOptions>(() => ({ confirm, onEvent }), [confirm, onEvent]);

  return { phase, diff, receipts, failure, options, approve, reject, reset, clearFailure };
}
