/**
 * Explorer URLs for the chains in Reactive's official origins-and-destinations table.
 *
 * ## Why a script-side copy of a table the app already has
 *
 * `app/src/config/chains.ts` is the source of truth for the application, but it cannot be
 * imported here: its modules use the `@/` path alias, which resolves against
 * `app/tsconfig.json` and not against `scripts/`. A script that guessed at an alias would
 * fail at run time, which is worse than a small, pinned duplication.
 *
 * The values are transcribed from the official table at
 * https://dev.reactive.network/origins-and-destinations and must match `config/chains.ts`.
 * `scripts/audit-surface.ts` enforces that with its `[CHAIN-TABLE]` gate, which compares every
 * entry here against the app's table and fails the build on any difference — so the copy cannot
 * drift silently. When adding a chain, update `config/chains.ts`,
 * `contracts/script/ReactiveChains.sol` and this file together.
 *
 * ## Why not fall back to basescan
 *
 * A wrong explorer link is a fabricated chain fact: it claims a transaction exists on a
 * chain it was never sent to. An unknown chain therefore resolves to `null`, and callers
 * omit the link rather than inventing one.
 */

const EXPLORERS: Readonly<Record<number, string>> = {
  // ---- mainnet ----
  1: "https://etherscan.io",
  56: "https://bscscan.com",
  130: "https://uniscan.xyz",
  999: "https://hyperevmscan.io",
  1597: "https://reactscan.net",
  4663: "https://robinhoodchain.blockscout.com",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  43114: "https://avascan.info",
  // ---- testnet ----
  1301: "https://sepolia.uniscan.xyz",
  5318007: "https://lasna.reactscan.net",
  84532: "https://sepolia.basescan.org",
  11155111: "https://sepolia.etherscan.io",
};

/**
 * Explorer base URL for a chain, or `null` when the chain is not in the table.
 *
 * An operator-supplied `SAPU_ORIGIN_EXPLORER_URL` / `SAPU_REACTIVE_EXPLORER_URL` wins, so
 * a private explorer or a chain added after this file was written still produces correct
 * links instead of none.
 */
export function explorerFor(chainId: number, override?: string | null): string | null {
  const trimmed = typeof override === "string" ? override.trim().replace(/\/$/, "") : "";
  if (trimmed.length > 0) return trimmed;
  return EXPLORERS[chainId] ?? null;
}
