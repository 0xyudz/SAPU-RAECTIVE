/**
 * Per-chain RPC endpoint overrides.
 *
 * ## Why a static table and not `process.env[\`NEXT_PUBLIC_RPC_URL_${id}\`]`
 *
 * Next.js only inlines environment variables into the browser bundle when it can see
 * the access statically (`process.env.NEXT_PUBLIC_FOO`). A computed lookup reads
 * `undefined` in the client, so the wallet's `wallet_addEthereumChain` call would be
 * handed an empty URL and silently add a broken network. Every key below is therefore
 * written out literally.
 *
 * ## Why most chains have no default
 *
 * Reactive publishes RPC endpoints only for its own chains. For every other origin /
 * destination the official table links to Chainlist and expects the operator to supply
 * an endpoint. Inventing a "reasonable looking" public RPC would be a fabricated
 * endpoint that fails at the first request, so anything not configured here resolves to
 * `null` and the caller reports "RPC not configured" instead of guessing.
 *
 * Two historical variables are honoured so existing deployments keep working:
 * `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` (chain 84532) and `NEXT_PUBLIC_REACTIVE_RPC_URL`
 * (Reactive Lasna, 5318007).
 */

const RPC_OVERRIDES: Readonly<Record<number, string | undefined>> = {
  // ---- mainnet ----
  1: process.env.NEXT_PUBLIC_RPC_URL_1,
  56: process.env.NEXT_PUBLIC_RPC_URL_56,
  130: process.env.NEXT_PUBLIC_RPC_URL_130,
  999: process.env.NEXT_PUBLIC_RPC_URL_999,
  1597: process.env.NEXT_PUBLIC_RPC_URL_1597,
  4663: process.env.NEXT_PUBLIC_RPC_URL_4663,
  8453: process.env.NEXT_PUBLIC_RPC_URL_8453,
  42161: process.env.NEXT_PUBLIC_RPC_URL_42161,
  43114: process.env.NEXT_PUBLIC_RPC_URL_43114,
  // ---- testnet ----
  1301: process.env.NEXT_PUBLIC_RPC_URL_1301,
  84532: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL_84532,
  11155111: process.env.NEXT_PUBLIC_RPC_URL_11155111,
  5318007: process.env.NEXT_PUBLIC_REACTIVE_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL_5318007,
};

function usable(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The operator-supplied endpoint for a chain, or `null` when none was configured. */
export function rpcOverride(chainId: number): string | null {
  return usable(RPC_OVERRIDES[chainId]);
}
