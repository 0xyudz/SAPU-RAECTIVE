"use client";


import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TxReceipt } from "@/domain/tx-receipt";
import {
  connectWallet,
  getServerWalletSnapshot,
  getWalletSnapshot,
  subscribeWallet,
  type WalletSnapshot,
} from "@/infrastructure/injected-wallet";

interface WalletContextValue {
  readonly wallet: WalletSnapshot;
  readonly connect: () => void;
  readonly sessionReceipts: readonly TxReceipt[];
  readonly addSessionReceipt: (receipt: TxReceipt) => void;
  readonly clearSessionReceipts: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useSyncExternalStore(subscribeWallet, getWalletSnapshot, getServerWalletSnapshot);
  const [sessionReceipts, setSessionReceipts] = useState<TxReceipt[]>([]);

  const connect = useCallback(() => {
    void connectWallet();
  }, []);

  const addSessionReceipt = useCallback((receipt: TxReceipt) => {
    setSessionReceipts((current) =>
      current.some((item) => item.chainId === receipt.chainId && item.hash === receipt.hash)
        ? current
        : [...current, receipt],
    );
  }, []);

  const clearSessionReceipts = useCallback(() => {
    setSessionReceipts([]);
  }, []);

  return (
    <WalletContext.Provider
      value={{ wallet, connect, sessionReceipts, addSessionReceipt, clearSessionReceipts }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (context === null) {
    throw new Error("useWallet must be used under WalletProvider.");
  }
  return context;
}
