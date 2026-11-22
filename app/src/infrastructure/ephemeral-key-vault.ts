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

let counter = 0;

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new Error(
      "EphemeralKeyVault is browser-only. Burner keys must never be generated or read on the server.",
    );
  }
}

export function createBurner(label?: string): BurnerHandle {
  assertBrowser();

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase() as Address;
  const createdAt = Date.now();
  const resolvedLabel = label ?? `burner-${String(++counter).padStart(2, "0")}`;

  store.set(address, { privateKey, createdAt, label: resolvedLabel });

  return { address, createdAt, label: resolvedLabel };
}

export function listBurners(): BurnerHandle[] {
  assertBrowser();
  return [...store.entries()].map(([address, entry]) => ({
    address,
    createdAt: entry.createdAt,
    label: entry.label,
  }));
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
  return store.delete(address.toLowerCase() as Address);
}

export function purgeAll(): void {
  assertBrowser();
  store.clear();
  counter = 0;
}

export function keyCount(): number {
  return store.size;
}
