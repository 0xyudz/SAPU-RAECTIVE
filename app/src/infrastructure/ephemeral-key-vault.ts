import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "@/domain/burner-route";

export interface BurnerHandle {
  readonly address: Address;
  readonly createdAt: number;
  readonly label: string;
}

export interface BurnerSecret {
  readonly privateKey: `0x${string}`;
}

const store = new Map<Address, { privateKey: `0x${string}`; createdAt: number; label: string }>();

const listeners = new Set<() => void>();

let counter = 0;

let snapshot: readonly BurnerHandle[] = [];

function publish(): void {
  snapshot = [...store.entries()].map(([address, entry]) => ({
    address,
    createdAt: entry.createdAt,
    label: entry.label,
  }));
  for (const listener of listeners) listener();
}

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new Error(
      "EphemeralKeyVault is browser-only. Burner keys must never be generated or read on the server.",
    );
  }
}

export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVaultSnapshot(): readonly BurnerHandle[] {
  return snapshot;
}

export function getServerVaultSnapshot(): readonly BurnerHandle[] {
  return snapshot;
}

export function createBurner(label?: string): BurnerHandle {
  assertBrowser();

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase() as Address;
  const createdAt = Date.now();
  const resolvedLabel = label ?? `burner-${String(++counter).padStart(2, "0")}`;

  store.set(address, { privateKey, createdAt, label: resolvedLabel });
  publish();

  return { address, createdAt, label: resolvedLabel };
}

export function revealSecret(address: Address): BurnerSecret {
  assertBrowser();
  const entry = store.get(address.toLowerCase() as Address);
  if (!entry) {
    throw new Error(`Unknown burner: ${address}`);
  }
  return { privateKey: entry.privateKey };
}

export function forgetBurner(address: Address): boolean {
  assertBrowser();
  const removed = store.delete(address.toLowerCase() as Address);
  if (removed) publish();
  return removed;
}

export function purgeAll(): void {
  assertBrowser();
  store.clear();
  counter = 0;
  publish();
}
