import { createWalletClient, custom, numberToHex, type WalletClient } from "viem";
import type { Address } from "@/domain/burner-route";
import { chainById } from "@/config/chains";
import { rpcOverride } from "@/config/chain-rpc";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface WalletSnapshot {
  readonly available: boolean;
  readonly connected: boolean;
  readonly address: Address | null;
  readonly chainId: number | null;
}

const DISCONNECTED: WalletSnapshot = {
  available: false,
  connected: false,
  address: null,
  chainId: null,
};

let snapshot: WalletSnapshot = DISCONNECTED;
const listeners = new Set<() => void>();
let attached = false;

function emit(next: WalletSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function provider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

function normalizeAddress(value: unknown): Address | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Address)
    : null;
}

function attachProvider(p: Eip1193Provider): void {
  if (attached) return;
  attached = true;
  p.on?.("accountsChanged", (...args) => {
    const accounts = args[0] as string[] | undefined;
    const address = accounts && accounts.length > 0 ? normalizeAddress(accounts[0]) : null;
    emit({
      available: true,
      connected: address !== null,
      address,
      chainId: snapshot.chainId,
    });
  });
  p.on?.("chainChanged", (...args) => {
    const hex = args[0] as string | undefined;
    const chainId = typeof hex === "string" ? Number.parseInt(hex, 16) : null;
    emit({ ...snapshot, available: true, chainId });
  });
}

export async function refreshWallet(): Promise<void> {
  const p = provider();
  if (!p) {
    if (snapshot.available) emit(DISCONNECTED);
    return;
  }
  attachProvider(p);
  try {
    const [accounts, chainHex] = await Promise.all([
      p.request({ method: "eth_accounts" }) as Promise<string[]>,
      p.request({ method: "eth_chainId" }) as Promise<string>,
    ]);
    const address = accounts.length > 0 ? normalizeAddress(accounts[0]) : null;
    emit({
      available: true,
      connected: address !== null,
      address,
      chainId: typeof chainHex === "string" ? Number.parseInt(chainHex, 16) : null,
    });
  } catch {
    emit({ available: true, connected: false, address: null, chainId: null });
  }
}

export async function connectWallet(): Promise<WalletSnapshot> {
  const p = provider();
  if (!p) {
    emit(DISCONNECTED);
    return snapshot;
  }
  attachProvider(p);
  const [accounts, chainHex] = await Promise.all([
    p.request({ method: "eth_requestAccounts" }) as Promise<string[]>,
    p.request({ method: "eth_chainId" }) as Promise<string>,
  ]);
  const address = accounts.length > 0 ? normalizeAddress(accounts[0]) : null;
  emit({
    available: true,
    connected: address !== null,
    address,
    chainId: typeof chainHex === "string" ? Number.parseInt(chainHex, 16) : null,
  });
  return snapshot;
}

export function subscribeWallet(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    void refreshWallet();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getWalletSnapshot(): WalletSnapshot {
  return snapshot;
}

export function getServerWalletSnapshot(): WalletSnapshot {
  return DISCONNECTED;
}

/**
 * `wallet_addEthereumChain` payload for a chain.
 *
 * Built from the chain table so every Reactive-supported chain is reachable, not just the
 * two that used to be hardcoded. Throws when the operator has not configured an RPC
 * endpoint: adding a network with an empty `rpcUrls` array leaves the wallet on a chain it
 * cannot talk to, which is worse than refusing.
 */
function chainParams(chainId: number): {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
} {
  const config = chainById(chainId);
  if (config === null) {
    throw new Error(`Chain ${chainId} is not a Reactive-supported chain, so it cannot be added to the wallet.`);
  }

  const rpcUrl = rpcOverride(chainId);
  if (rpcUrl === null) {
    throw new Error(
      `No RPC endpoint configured for ${config.name} (${chainId}). ` +
        `Set NEXT_PUBLIC_RPC_URL_${chainId} before adding this chain to a wallet.`,
    );
  }

  return {
    chainId: numberToHex(chainId),
    chainName: config.name,
    rpcUrls: [rpcUrl],
    blockExplorerUrls: [config.explorerUrl],
    // The table leaves the ticker unset for some chains. "native" is honest; inventing a
    // symbol would make the wallet display a currency that does not exist.
    nativeCurrency: {
      name: config.nativeSymbol ?? "Native",
      symbol: config.nativeSymbol ?? "native",
      decimals: config.nativeDecimals,
    },
  };
}

export async function ensureChain(chainId: number): Promise<void> {
  const p = provider();
  if (!p) throw new Error("No injected wallet. Connect one first.");

  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chainId) }],
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [chainParams(chainId)],
    });
  }
}

export function getWalletClient(): WalletClient | null {
  const p = provider();
  if (!p || snapshot.address === null) return null;
  return createWalletClient({
    account: snapshot.address,
    transport: custom(p),
  });
}

export function currentAccount(): Address | null {
  return snapshot.address;
}
