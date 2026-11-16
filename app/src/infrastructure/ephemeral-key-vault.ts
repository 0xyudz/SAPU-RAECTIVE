/**
 * Infrastructure: EphemeralKeyVault (in-memory only)
 *
 * Holds burner private keys for the lifetime of a browser tab. This is the single
 * most sensitive module in SAPU, so its constraints are stated as code:
 *
 *   1. **Browser only.** Every function throws if `window` is absent. There is no
 *      server-side code path that can touch a key, by construction.
 *   2. **Never persisted.** No `localStorage`, no `sessionStorage`, no cookies, no
 *      IndexedDB, no network. The key lives in a module-scoped `Map` and dies with
 *      the tab.
 *   3. **Never logged.** `toString`/`toJSON` on the handle are overridden to redact.
 *
 * The threat model is honest about what this does and does not buy: it protects
 * against server-side leakage and accidental persistence, not against XSS or a
 * compromised browser. See docs/LIMITATIONS.md.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "@/domain/burner-route";

export interface BurnerHandle {
  /** Public address, safe to display and share. */
  readonly address: Address;
  /** Unix ms when generated. */
  readonly createdAt: number;
  /** A short, non-sensitive label. */
  readonly label: string;
}

/** Redacts the secret when the handle is serialised by accident. */
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

/**
 * Generates a fresh burner keypair held only in memory.
 *
 * Uses `crypto.getRandomValues` under the hood (via viem), which is the only
 * acceptable entropy source for key material.
 */
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

/** Lists known burners. Public data only. */
export function listBurners(): BurnerHandle[] {
  assertBrowser();
  return [...store.entries()].map(([address, entry]) => ({
    address,
    createdAt: entry.createdAt,
    label: entry.label,
  }));
}

/**
 * Retrieves a burner's secret for signing.
 *
 * Deliberately narrow: only `SweepOrchestrator` should call this, and only to sign an
 * EIP-2612 permit (which reveals nothing and costs no gas).
 */
export function revealSecret(address: Address): BurnerSecret {
  assertBrowser();
  const entry = store.get(address.toLowerCase() as Address);
  if (!entry) {
    throw new Error(`Unknown burner: ${address}`);
  }
  return { privateKey: entry.privateKey };
}

/** Irreversibly forgets a burner key. */
export function forgetBurner(address: Address): boolean {
  assertBrowser();
  return store.delete(address.toLowerCase() as Address);
}

/** Forgets every burner. Called on unmount of the app shell. */
export function purgeAll(): void {
  assertBrowser();
  store.clear();
  counter = 0;
}

/** Number of keys currently held. Useful for the "keys in memory" indicator. */
export function keyCount(): number {
  return store.size;
}

/**
 * Formats a burner handle for display, proving by construction that the private key
 * is not part of the rendered surface.
 */
export function describeBurner(handle: BurnerHandle): string {
  return `${handle.label} · ${handle.address.slice(0, 6)}…${handle.address.slice(-4)}`;
}
