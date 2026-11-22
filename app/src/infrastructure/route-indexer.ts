import { parseAbiItem } from "viem";
import type { Address } from "@/domain/burner-route";
import { diagnoseRoute, type RegistryDiagnosis } from "@/domain/registry";
import { readDeploymentConfig } from "@/config/chains";
import { DEFAULT_LEDGER_LOOKBACK } from "@/config/constants";
import { contractTarget, verifyDeployment, type DeploymentVerification } from "./contracts";
import { getLogsChunked, type DecodedLog } from "./logs";
import {
  readCallbackGasLimit,
  readForwarderSet,
  readHead,
  readOwner,
  readRoute,
  readRule,
  readSubscriptionCount,
  readSweepCount,
  readTokensOf,
} from "./chain-reads";
import { readBudget } from "./budget-reader";

const ROUTE_REGISTERED = parseAbiItem(
  "event RouteRegistered(address indexed burner, address indexed coldWallet, address indexed token, uint64 gasLimit)",
);
const ROUTE_REVOKED = parseAbiItem("event RouteRevoked(address indexed burner, address indexed token)");
const FORWARDER_SET = parseAbiItem("event ForwarderSet(address indexed forwarder)");
const GAS_LIMIT_SET = parseAbiItem("event CallbackGasLimitSet(uint64 gasLimit)");
const ROUTE_ARMED = parseAbiItem(
  "event RouteArmed(address indexed burner, address indexed token, address indexed coldWallet)",
);
const ROUTE_DISARMED = parseAbiItem("event RouteDisarmed(address indexed burner, address indexed token)");

export interface RouteIndexRow {
  readonly burner: Address;
  readonly token: Address;
  readonly rscActive: boolean;
  readonly forwarderArmed: boolean;
  readonly rscColdWallet: Address | null;
  readonly forwarderColdWallet: Address | null;
  readonly rscTokens: readonly Address[];
  readonly registeredBlock: string | null;
  readonly registeredTx: `0x${string}` | null;
  readonly revokedTx: `0x${string}` | null;
  readonly lastEventBlock: string | null;
  readonly diagnosis: RegistryDiagnosis;
  readonly readError?: string;
}

export interface RouteIndexCounters {
  readonly routes: number;
  readonly armed: number;
  readonly needsRepair: number;
  readonly rscOnly: number;
  readonly forwarderOnly: number;
  readonly drifted: number;
  readonly revoked: number;
}

export interface RouteIndexBudget {
  readonly callbackGasLimit: string;
  readonly rscBalance: string;
  readonly forwarderBalance: string;
  readonly gasPrice: string;
  readonly rscDebt: string;
  readonly forwarderDebt: string;
  readonly sweepsRemaining: string;
  readonly costPerSweepWei: string;
}

export interface RouteIndex {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly rsc: Address | null;
  readonly forwarder: Address | null;
  readonly token: Address | null;
  readonly rscForwarder: Address | null;
  readonly rscOwner: Address | null;
  readonly forwarderOwner: Address | null;
  readonly callbackGasLimit: string | null;
  readonly sweepCount: string | null;
  readonly subscriptionCount: string | null;
  readonly rows: readonly RouteIndexRow[];
  readonly counters: RouteIndexCounters;
  readonly budget: RouteIndexBudget | null;
  readonly heads: { readonly base: string | null; readonly reactive: string | null };
  readonly verification: DeploymentVerification;
  readonly checkedAt: string;
}

interface PairState {
  burner: Address;
  token: Address;
  registeredBlock: bigint | null;
  registeredTx: `0x${string}` | null;
  revokedTx: `0x${string}` | null;
  lastEventBlock: bigint | null;
}

function pairKey(token: Address, burner: Address): string {
  return `${token}:${burner}`;
}

function asAddress(value: unknown): Address {
  return String(value).toLowerCase() as Address;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

function ordered(rows: readonly RouteIndexRow[]): RouteIndexRow[] {
  return [...rows].sort((a, b) => {
    const aBlock = a.lastEventBlock === null ? -1n : BigInt(a.lastEventBlock);
    const bBlock = b.lastEventBlock === null ? -1n : BigInt(b.lastEventBlock);
    if (aBlock === bBlock) return a.burner.localeCompare(b.burner);
    return aBlock < bBlock ? 1 : -1;
  });
}

async function buildIndex(): Promise<RouteIndex> {
  const config = readDeploymentConfig();
  const verification = await verifyDeployment();

  if (config.rscAddress === null || config.forwarderAddress === null || config.tokenAddress === null) {
    return {
      configured: false,
      verified: false,
      error: "Deployment addresses are not configured. Set them in .env.local or run scripts/deploy-live.sh.",
      rsc: config.rscAddress,
      forwarder: config.forwarderAddress,
      token: config.tokenAddress,
      rscForwarder: null,
      rscOwner: null,
      forwarderOwner: null,
      callbackGasLimit: null,
      sweepCount: null,
      subscriptionCount: null,
      rows: [],
      counters: { routes: 0, armed: 0, needsRepair: 0, rscOnly: 0, forwarderOnly: 0, drifted: 0, revoked: 0 },
      budget: null,
      heads: { base: null, reactive: null },
      verification,
      checkedAt: new Date().toISOString(),
    };
  }

  const rsc = contractTarget("rsc");
  const forwarder = contractTarget("forwarder");

  if (!verification.verified) {
    const failed = verification.checks
      .filter((check) => check.hasCode !== true)
      .map((check) => `${check.name}: ${check.error ?? "no code"}`)
      .join("; ");
    return {
      configured: true,
      verified: false,
      error: `Configured addresses have no contract code. ${failed}`,
      rsc: config.rscAddress,
      forwarder: config.forwarderAddress,
      token: config.tokenAddress,
      rscForwarder: null,
      rscOwner: null,
      forwarderOwner: null,
      callbackGasLimit: null,
      sweepCount: null,
      subscriptionCount: null,
      rows: [],
      counters: { routes: 0, armed: 0, needsRepair: 0, rscOnly: 0, forwarderOnly: 0, drifted: 0, revoked: 0 },
      budget: null,
      heads: { base: null, reactive: null },
      verification,
      checkedAt: new Date().toISOString(),
    };
  }

  const [baseHead, reactiveHead] = await Promise.all([
    readHead("base").catch(() => null),
    readHead("reactive").catch(() => null),
  ]);

  const rscFrom =
    config.rscDeployBlock ?? (reactiveHead !== null && reactiveHead > DEFAULT_LEDGER_LOOKBACK ? reactiveHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const forwarderFrom =
    config.forwarderDeployBlock ?? (baseHead !== null && baseHead > DEFAULT_LEDGER_LOOKBACK ? baseHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const rscTo = reactiveHead ?? 0n;
  const forwarderTo = baseHead ?? 0n;

  const pairs = new Map<string, PairState>();
  const ensure = (token: Address, burner: Address): PairState => {
    const key = pairKey(token, burner);
    let state = pairs.get(key);
    if (!state) {
      state = {
        burner,
        token,
        registeredBlock: null,
        registeredTx: null,
        revokedTx: null,
        lastEventBlock: null,
      };
      pairs.set(key, state);
    }
    return state;
  };
  const touch = (state: PairState, block: bigint): void => {
    if (state.lastEventBlock === null || block > state.lastEventBlock) state.lastEventBlock = block;
  };

  const eventErrors: string[] = [];

  if (rscTo >= rscFrom) {
    const [registered, revoked, forwarderSet, gasLimitSet] = await Promise.all([
      getLogsChunked({ client: rsc.client, address: rsc.address, event: ROUTE_REGISTERED, fromBlock: rscFrom, toBlock: rscTo }).catch((error) => {
        eventErrors.push(`RouteRegistered: ${reasonOf(error)}`);
        return [] as DecodedLog[];
      }),
      getLogsChunked({ client: rsc.client, address: rsc.address, event: ROUTE_REVOKED, fromBlock: rscFrom, toBlock: rscTo }).catch((error) => {
        eventErrors.push(`RouteRevoked: ${reasonOf(error)}`);
        return [] as DecodedLog[];
      }),
      getLogsChunked({ client: rsc.client, address: rsc.address, event: FORWARDER_SET, fromBlock: rscFrom, toBlock: rscTo }).catch(
        () => [] as DecodedLog[],
      ),
      getLogsChunked({ client: rsc.client, address: rsc.address, event: GAS_LIMIT_SET, fromBlock: rscFrom, toBlock: rscTo }).catch(
        () => [] as DecodedLog[],
      ),
    ]);

    for (const log of registered) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      state.registeredBlock = log.blockNumber;
      state.registeredTx = log.transactionHash;
      touch(state, log.blockNumber);
    }
    for (const log of revoked) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      state.revokedTx = log.transactionHash;
      touch(state, log.blockNumber);
    }
    void forwarderSet;
    void gasLimitSet;
  }

  if (forwarderTo >= forwarderFrom) {
    const [armed, disarmed] = await Promise.all([
      getLogsChunked({ client: forwarder.client, address: forwarder.address, event: ROUTE_ARMED, fromBlock: forwarderFrom, toBlock: forwarderTo }).catch((error) => {
        eventErrors.push(`RouteArmed: ${reasonOf(error)}`);
        return [] as DecodedLog[];
      }),
      getLogsChunked({ client: forwarder.client, address: forwarder.address, event: ROUTE_DISARMED, fromBlock: forwarderFrom, toBlock: forwarderTo }).catch((error) => {
        eventErrors.push(`RouteDisarmed: ${reasonOf(error)}`);
        return [] as DecodedLog[];
      }),
    ]);

    for (const log of armed) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      touch(state, log.blockNumber);
    }
    for (const log of disarmed) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      touch(state, log.blockNumber);
    }
  }

  const rows: RouteIndexRow[] = await Promise.all(
    [...pairs.values()].map(async (pair): Promise<RouteIndexRow> => {
      try {
        const [route, rule, rscTokens] = await Promise.all([
          readRoute(rsc.address, pair.token, pair.burner),
          readRule(forwarder.address, pair.token, pair.burner),
          readTokensOf(rsc.address, pair.burner).catch(() => [] as readonly Address[]),
        ]);
        const diagnosis = diagnoseRoute({
          rscActive: route.active,
          forwarderArmed: rule.armed,
          rscColdWallet: route.active ? route.coldWallet : null,
          forwarderColdWallet: rule.armed ? rule.coldWallet : null,
        });
        return {
          burner: pair.burner,
          token: pair.token,
          rscActive: route.active,
          forwarderArmed: rule.armed,
          rscColdWallet: route.active ? route.coldWallet : null,
          forwarderColdWallet: rule.armed ? rule.coldWallet : null,
          rscTokens,
          registeredBlock: pair.registeredBlock?.toString() ?? null,
          registeredTx: pair.registeredTx,
          revokedTx: pair.revokedTx,
          lastEventBlock: pair.lastEventBlock?.toString() ?? null,
          diagnosis,
        };
      } catch (error) {
        return {
          burner: pair.burner,
          token: pair.token,
          rscActive: false,
          forwarderArmed: false,
          rscColdWallet: null,
          forwarderColdWallet: null,
          rscTokens: [],
          registeredBlock: pair.registeredBlock?.toString() ?? null,
          registeredTx: pair.registeredTx,
          revokedTx: pair.revokedTx,
          lastEventBlock: pair.lastEventBlock?.toString() ?? null,
          diagnosis: {
            status: "rsc-only",
            tone: "warn",
            summary: "Could not confirm both sides; the last read failed.",
            repair: null,
          },
          readError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const [rscOwner, forwarderOwner, rscForwarder, callbackGasLimit, sweepCount, subscriptionCount, budget] =
    await Promise.all([
      readOwner("rsc"),
      readOwner("forwarder"),
      readForwarderSet(config.rscAddress).catch(() => null),
      readCallbackGasLimit(config.rscAddress).catch(() => null),
      readSweepCount(config.forwarderAddress).catch(() => null),
      readSubscriptionCount(config.rscAddress).catch(() => null),
      readBudget(config.rscAddress, config.forwarderAddress).catch(() => null),
    ]);

  const counts = {
    rscOnly: rows.filter((row) => row.diagnosis.status === "rsc-only").length,
    forwarderOnly: rows.filter((row) => row.diagnosis.status === "forwarder-only").length,
    drifted: rows.filter((row) => row.diagnosis.status === "drifted").length,
    revoked: rows.filter((row) => row.diagnosis.status === "revoked").length,
  };

  return {
    configured: true,
    verified: true,
    error: eventErrors.length > 0 ? `Some events could not be indexed: ${eventErrors.join("; ")}` : undefined,
    rsc: config.rscAddress,
    forwarder: config.forwarderAddress,
    token: config.tokenAddress,
    rscForwarder,
    rscOwner,
    forwarderOwner,
    callbackGasLimit: callbackGasLimit?.toString() ?? null,
    sweepCount: sweepCount?.toString() ?? null,
    subscriptionCount: subscriptionCount?.toString() ?? null,
    rows: ordered(rows),
    counters: {
      routes: rows.length,
      armed: rows.filter((row) => row.diagnosis.status === "agree").length,
      needsRepair: counts.rscOnly + counts.forwarderOnly + counts.drifted,
      ...counts,
    },
    budget: budget
      ? {
          callbackGasLimit: budget.callbackGasLimit.toString(),
          rscBalance: budget.rscBalance.toString(),
          forwarderBalance: budget.forwarderBalance.toString(),
          gasPrice: budget.gasPrice.toString(),
          rscDebt: budget.rscDebt.toString(),
          forwarderDebt: budget.forwarderDebt.toString(),
          sweepsRemaining: budget.budget.sweepsRemaining.toString(),
          costPerSweepWei: budget.budget.costPerSweepWei.toString(),
        }
      : null,
    heads: {
      base: baseHead?.toString() ?? null,
      reactive: reactiveHead?.toString() ?? null,
    },
    verification,
    checkedAt: new Date().toISOString(),
  };
}

interface CacheEntry {
  readonly at: number;
  readonly promise: Promise<RouteIndex>;
}

let cache: CacheEntry | null = null;
const TTL_MS = 15_000;

export function loadRouteIndex(): Promise<RouteIndex> {
  const now = Date.now();
  if (cache !== null && now - cache.at < TTL_MS) return cache.promise;
  const promise = buildIndex().catch((error): RouteIndex => ({
    configured: false,
    verified: false,
    error: error instanceof Error ? error.message : String(error),
    rsc: null,
    forwarder: null,
    token: null,
    rscForwarder: null,
    rscOwner: null,
    forwarderOwner: null,
    callbackGasLimit: null,
    sweepCount: null,
    subscriptionCount: null,
    rows: [],
    counters: { routes: 0, armed: 0, needsRepair: 0, rscOnly: 0, forwarderOnly: 0, drifted: 0, revoked: 0 },
    budget: null,
    heads: { base: null, reactive: null },
    verification: { configured: false, verified: false, checks: [] },
    checkedAt: new Date().toISOString(),
  }));
  cache = { at: now, promise };
  return promise;
}
