/**
 * A headless `ContractWriter` for the live proof scripts.
 *
 * The application's writers are built around an injected browser wallet
 * (`createConnectedWriter`). The proof scripts need the same behaviour from a private key, and
 * they must not re-implement the pipeline: `simulateCall` and `submitPrepared` are imported
 * from the app, so a proof exercises the production path and not a parallel one.
 *
 * ## Why the retry pins the nonce
 *
 * The public Base Sepolia gateways answer bursts of `eth_sendRawTransaction` with 429
 * ("Request exceeds defined limit"), and a single transient 429 must not end a proof run.
 * Retrying naively is not safe either: re-reading the pending nonce and re-sending could land two
 * transactions if the first actually made it.
 *
 * Pinning the nonce makes the retry idempotent. The same `(nonce, to, data, value, gas)` signs
 * to the same bytes, so every attempt broadcasts the *same* transaction hash; the node either
 * accepts it or answers "already known", and either way exactly one transaction exists. That is
 * why the nonce is merged into the request for the replays, rather than being re-derived on
 * every attempt.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWalletClient, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ContractCall, Simulation } from "@/application/ports";
import type {
  ArmingSnapshot,
  ArmInspectInput,
  PermitRequest,
  PermitSignature,
} from "@/application/registration-service";
import type { TxReceipt } from "@/domain/tx-receipt";

// Must stay first: importing the app's `write-support` pulls in `config/chain-rpc.ts`, which
// snapshots `process.env` at module scope. A caller that loads `.env` after importing this file
// would hand the app an empty RPC table, so this module loads the environment itself rather than
// depending on its importer's statement order.
import "./env.mts";
import { isNonceConflict, isTransientRpcError, signerTransport, sleep } from "./rpc";

const APP = path.resolve(import.meta.dirname, "..", "..", "app");
const appModule = (relative: string) => pathToFileURL(path.join(APP, relative)).href;

// The runtime functions come from the app itself so a proof exercises the production pipeline.
// Their *types* are imported statically above: a computed `await import()` is typed `unknown`,
// which would leave the writer's `call` parameter untyped and silently defeat typecheck.
const { simulateCall, submitPrepared, asPreparedSimulation } = await import(
  appModule("src/infrastructure/write-support.ts")
);

/**
 * The app's real inspection logic, reused rather than re-implemented.
 *
 * `armRoute` calls `port.inspect` before deciding which steps to run. A headless writer that
 * omitted it would fail at the first step with "port.inspect is not a function", so the proof
 * would never reach the code it is meant to exercise. Importing `createArmWriter` keeps the
 * snapshot logic identical to the browser's — only the wallet is substituted.
 */
const { createArmWriter } = await import(appModule("src/infrastructure/arm-writer.ts"));

/** Where one contract key lives: which chain, which account, which node. */
export interface WriterRoute {
  readonly address: `0x${string}`;
  readonly privateKey: `0x${string}`;
  readonly rpcUrl: string;
  /**
   * Extra endpoints to fall back to when the primary answers 429/timeout.
   *
   * Retries are nonce-pinned, so every attempt re-signs identical bytes and fails over without
   * risking a duplicate transaction. Omitted, the route is single-endpoint and a burst of 429s
   * ends the run.
   */
  readonly fallbacks?: readonly string[];
  readonly publicClient: PublicClient;
}

export interface HeadlessWriterOptions {
  readonly routeFor: (call: ContractCall) => WriterRoute;
  readonly attempts?: number;
  /**
   * Burner key, when the proof needs the permit/approve path.
   *
   * `armRoute` grants the forwarder an allowance either by relaying an EIP-2612 signature or,
   * for tokens without permit, by sending `approve` as the burner. Both need the burner key:
   * without it the flow correctly refuses with "no burner key is available", which is the right
   * behaviour in the browser (where a key may not be loaded) but would make a headless proof
   * fail for a reason that has nothing to do with what it is proving.
   */
  readonly burnerPrivateKey?: `0x${string}` | null;
}

export interface HeadlessWriter {
  inspect(input: ArmInspectInput): Promise<ArmingSnapshot>;
  simulateContract(call: ContractCall): Promise<Simulation>;
  send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt>;
  /** Burner-signed `approve`, for tokens with no EIP-2612 permit. */
  approveAsBurner: {
    canSignAsBurner(address: `0x${string}`): Promise<boolean>;
    sendAsBurner(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt>;
  };
  /** EIP-2612 signature, when the burner key is available. */
  signPermit(request: PermitRequest): Promise<PermitSignature | null>;
  /** Whether the token exposes permit + nonces, proxy-aware. */
  permitSupport(token: `0x${string}`): Promise<boolean | null>;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0]!;
  return String(error);
}

export function createHeadlessWriter(options: HeadlessWriterOptions): HeadlessWriter {
  const attempts = options.attempts ?? 6;
  const clients = new Map<string, ReturnType<typeof createWalletClient>>();

  const walletFor = (route: WriterRoute) => {
    const key = `${route.address}:${route.rpcUrl}`;
    let client = clients.get(key);
    if (!client) {
      // A real local account, not a `{ address, privateKey }` literal: viem signs through
      // `account.signTransaction`, which a plain object does not have. Passing the literal made
      // every send fail with "account.signTransaction is not a function".
      client = createWalletClient({
        account: privateKeyToAccount(route.privateKey),
        transport: signerTransport(route.rpcUrl, [...(route.fallbacks ?? [])]),
      });
      clients.set(key, client);
    }
    return client;
  };

  return {
    async inspect(input: ArmInspectInput): Promise<ArmingSnapshot> {
      // Delegated to the app's own writer: it reads the snapshot with the app's ABIs and the
      // same `(token, burner)` keys, so a proof cannot drift from the browser's inspection.
      return createArmWriter({ burnerPrivateKey: options.burnerPrivateKey ?? null }).inspect(input);
    },

    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, options.routeFor(call).address);
    },

    /**
     * The burner-signed `approve` fallback, for tokens with no EIP-2612 permit.
     *
     * Delegated to the app's writer so the gas preflight and the send pipeline are the
     * production ones; only the wallet differs.
     */
    approveAsBurner: {
      async canSignAsBurner(address: `0x${string}`): Promise<boolean> {
        const key = options.burnerPrivateKey;
        if (!key) return false;
        return privateKeyToAccount(key).address.toLowerCase() === address.toLowerCase();
      },
      async sendAsBurner(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt> {
        const appWriter = createArmWriter({ burnerPrivateKey: options.burnerPrivateKey ?? null });
        return appWriter.approveAsBurner!.sendAsBurner(prepared, onPending);
      },
    },

    /** The EIP-2612 signature, signed by the burner key the app's writer holds. */
    async signPermit(request: PermitRequest): Promise<PermitSignature | null> {
      const appWriter = createArmWriter({ burnerPrivateKey: options.burnerPrivateKey ?? null });
      return appWriter.signPermit!(request);
    },

    async permitSupport(token: `0x${string}`): Promise<boolean | null> {
      const appWriter = createArmWriter({ burnerPrivateKey: options.burnerPrivateKey ?? null });
      return appWriter.permitSupport!(token);
    },

    async send(prepared: unknown, onPending?: (hash: `0x${string}`) => void): Promise<TxReceipt> {
      const { call, request } = asPreparedSimulation(prepared);
      const route = options.routeFor(call);
      const wallet = walletFor(route);

      let delay = 2_000;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // Read the nonce once per attempt, then hold it across the replays below so every
        // broadcast is the same transaction.
        const nonce = await route.publicClient.getTransactionCount({
          address: route.address,
          blockTag: "pending",
        });

        for (let replay = 1; ; replay += 1) {
          try {
            return await submitPrepared(
              wallet as never,
              { ...(request as object), nonce },
              call,
              onPending,
            );
          } catch (error) {
            lastError = error;
            // `submitPrepared` waits for the receipt, so a transport error here may mean the
            // write was rejected (safe to re-broadcast the identical transaction) or that the
            // receipt never arrived (also safe: same hash). Anything else is a real failure.
            if (!isTransientRpcError(error) && !isNonceConflict(error)) throw error;
            if (replay >= 3) break;
            console.warn(
              `  ${call.label}: ${describe(error)} (attempt ${attempt}/${attempts}, replay ${replay})`,
            );
            await sleep(delay);
          }
        }

        delay = Math.min(Math.round(delay * 1.5), 20_000);
      }

      throw lastError instanceof Error ? lastError : new Error(`${call.label} failed`);
    },
  };
}
