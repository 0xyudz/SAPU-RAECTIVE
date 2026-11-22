import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";
import type { Address } from "@/domain/burner-route";
import { diagnoseRoute, type RegistryDiagnosis } from "@/domain/registry";
import { readDeploymentConfig } from "@/config/chains";
import { DEFAULT_LEDGER_LOOKBACK } from "@/config/constants";
import { contractTarget, verifyDeployment, type DeploymentVerification } from "./contracts";
import { createCachedLoader } from "./cache";
import { getRawLogs, type RawLog } from "./logs";
import {
  readCallbackGasLimit,
  readForwarderSet,
  readHead,
  readOwner,
  readSubscriptionCount,
  readSweepCount,
} from "./chain-reads";
import { decode, encode, multicall, lower } from "./multicall";
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

interface Decoded {
  readonly name: string;
  readonly blockNumber: bigint;
  readonly transactionHash: `0x${string}`;
  readonly args: Record<string, unknown>;
}

function decodeAll(logs: readonly RawLog[], events: readonly unknown[]): Decoded[] {
  const byTopic = new Map<string, unknown>();
  for (const event of events) {
    const fragment = event as { name: string };
    byTopic.set(toEventSelector(event as never), event);
    byTopic.set(fragment.name, event);
  }

  const out: Decoded[] = [];
  for (const log of logs) {
    const topic = log.topics[0];
    if (topic === undefined) continue;
    const event = byTopic.get(topic);
    if (event === undefined) continue;
    try {
      const decoded = decodeEventLog({
        abi: [event] as never,
        data: log.data,
        topics: log.topics as never,
      });
      out.push({
        name: decoded.eventName ?? "",
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        args: decoded.args as unknown as Record<string, unknown>,
      });
    } catch {
    }
  }
  return out;
}

function safeDecode<T>(abi: readonly unknown[], functionName: string, data: `0x${string}`): T | null {
  try {
    return decode<T>(abi, functionName, data);
  } catch {
    return null;
  }
}

function group(logs: readonly Decoded[]): Map<string, Decoded[]> {
  const out = new Map<string, Decoded[]>();
  for (const log of logs) {
    const list = out.get(log.name) ?? [];
    list.push(log);
    out.set(log.name, list);
  }
  return out;
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
    const raw = await getRawLogs({
      client: rsc.client,
      address: rsc.address,
      fromBlock: rscFrom,
      toBlock: rscTo,
      cacheKeySuffix: "rsc-events",
    }).catch((error) => {
      eventErrors.push(`SapuRSC events: ${reasonOf(error)}`);
      return [] as RawLog[];
    });

    const grouped = group(
      decodeAll(raw, [ROUTE_REGISTERED, ROUTE_REVOKED, FORWARDER_SET, GAS_LIMIT_SET]),
    );

    for (const log of grouped.get("RouteRegistered") ?? []) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      state.registeredBlock = log.blockNumber;
      state.registeredTx = log.transactionHash;
      touch(state, log.blockNumber);
    }
    for (const log of grouped.get("RouteRevoked") ?? []) {
      const state = ensure(asAddress(log.args.token), asAddress(log.args.burner));
      state.revokedTx = log.transactionHash;
      touch(state, log.blockNumber);
    }
  }

  if (forwarderTo >= forwarderFrom) {
    const raw = await getRawLogs({
      client: forwarder.client,
      address: forwarder.address,
      fromBlock: forwarderFrom,
      toBlock: forwarderTo,
      cacheKeySuffix: "forwarder-events",
    }).catch((error) => {
      eventErrors.push(`SapuForwarder events: ${reasonOf(error)}`);
      return [] as RawLog[];
    });

    const grouped = group(decodeAll(raw, [ROUTE_ARMED, ROUTE_DISARMED]));

    for (const log of grouped.get("RouteArmed") ?? []) {
      touch(ensure(asAddress(log.args.token), asAddress(log.args.burner)), log.blockNumber);
    }
    for (const log of grouped.get("RouteDisarmed") ?? []) {
      touch(ensure(asAddress(log.args.token), asAddress(log.args.burner)), log.blockNumber);
    }
  }

  const pairList = [...pairs.values()];

  const forwarderCalls = pairList.map((pair) => ({
    target: forwarder.address,
    callData: encode(forwarder.abi, "ruleOf", [pair.token, pair.burner]),
  }));
  const rscCalls = pairList.map((pair) => ({
    target: rsc.address,
    callData: encode(rsc.abi, "routeOf", [pair.token, pair.burner]),
  }));

  const [forwarderResults, rscResults] = await Promise.all([
    multicall(forwarderCalls, "base").catch(() => pairList.map(() => null)),
    multicall(rscCalls, "reactive").catch(() => pairList.map(() => null)),
  ]);

  const rows: RouteIndexRow[] = pairList.map((pair, index): RouteIndexRow => {
    const forwarderData = forwarderResults[index] ?? null;
    const rscData = rscResults[index] ?? null;

    const rule =
      forwarderData === null || forwarderData === "0x"
        ? null
        : safeDecode<{ coldWallet: Address; armed: boolean }>(forwarder.abi, "ruleOf", forwarderData);
    const route =
      rscData === null || rscData === "0x"
        ? null
        : safeDecode<{ coldWallet: Address; active: boolean }>(rsc.abi, "routeOf", rscData);

    if (rule === null || route === null) {
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
        readError: "batch read returned no data for this pair",
      };
    }

    const diagnosis = diagnoseRoute({
      rscActive: route.active,
      forwarderArmed: rule.armed,
      rscColdWallet: route.active ? lower(route.coldWallet) : null,
      forwarderColdWallet: rule.armed ? lower(rule.coldWallet) : null,
    });

    return {
      burner: pair.burner,
      token: pair.token,
      rscActive: route.active,
      forwarderArmed: rule.armed,
      rscColdWallet: route.active ? lower(route.coldWallet) : null,
      forwarderColdWallet: rule.armed ? lower(rule.coldWallet) : null,
      rscTokens: [],
      registeredBlock: pair.registeredBlock?.toString() ?? null,
      registeredTx: pair.registeredTx,
      revokedTx: pair.revokedTx,
      lastEventBlock: pair.lastEventBlock?.toString() ?? null,
      diagnosis,
    };
  });

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

function emptyRouteIndex(error: unknown): RouteIndex {
  return {
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
  };
}

const routeIndexLoader = createCachedLoader<RouteIndex>({
  build: () => buildIndex().catch(emptyRouteIndex),
  freshMs: 8_000,
  staleMs: 120_000,
});

export function loadRouteIndex(): Promise<RouteIndex> {
  return routeIndexLoader.load();
}
