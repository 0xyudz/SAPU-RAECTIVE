/**
 * Loads the operator's environment once, before any application module is imported.
 *
 * ## Why this is its own module
 *
 * The app's `config/chain-rpc.ts` reads `process.env.NEXT_PUBLIC_RPC_URL_*` at module scope and
 * snapshots the values into a static table (Next.js can only inline statically-visible keys).
 * A script that calls `dotenv` in its own body *after* importing an application module therefore
 * gets a table full of `undefined`, and the failure surfaces much later and much less clearly:
 * "No RPC endpoint configured for Base Sepolia (84532)" even though `app/.env.local` sets it.
 *
 * That is exactly what happened when the live proofs started sharing `lib/app-writer.mts`: its
 * static import is evaluated before the importing script's first statement, so `loadEnv` had
 * not run yet. Importing this module first makes the ordering explicit instead of accidental.
 *
 * `app/.env.local` is loaded first and the repo-root `.env` second. `dotenv` never overwrites an
 * existing value, so the app-specific file wins, which is the same precedence Next.js applies.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

loadEnv({ path: path.join(REPO_ROOT, "app", ".env.local"), quiet: true });
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

/** Repository root, resolved from this file rather than from the caller's cwd. */
export const repoRoot = REPO_ROOT;
