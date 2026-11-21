import { decodeFunctionData, parseAbiItem } from "viem";
import type { Address } from "@/domain/burner-route";
import {
  classifyLedger,
  countLedger,
  ledgerLatencyMs,
  type LedgerCounts,
  type LedgerLegView,
  type LedgerRow,
} from "@/domain/ledger";
import { BASE_SEPOLIA, REACTIVE_LASNA, SYSTEM_CONTRACT, readDeploymentConfig } from "@/config/chains";
import { DEFAULT_LEDGER_LOOKBACK } from "@/config/constants";
import { sapuForwarderAbi } from "@/config/abis";
import { contractTarget, verifyDeployment, type DeploymentVerification } from "./contracts";
import { getLogsChunked, type DecodedLog } from "./logs";
import { readHead, readRoute } from "./chain-reads";
import { getBlockTimestamp } from "./base-sepolia-client";
import { decodeCallbackPayload } from "./reactive-rpc-client";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const TOKENS_SWEPT = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);
const PURGE_TRIGGERED = parseAbiItem(
  "event PurgeTriggered(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, uint256 originBlockNumber)",
);
const CALLBACK_REQUEST = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);

export interface LedgerWindow {
  readonly baseFrom: string | null;
  readonly baseTo: string | null;
  readonly reactiveFrom: string | null;
  readonly reactiveTo: string | null;
}

export interface LedgerIndex {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly rsc: Address | null;
  readonly forwarder: Address | null;
  readonly token: Address | null;
  readonly rows: readonly LedgerRow[];
  readonly counts: LedgerCounts;
  readonly window: LedgerWindow;
  readonly heads: { readonly base: string | null; readonly reactive: string | null };
  readonly verification: DeploymentVerification;
  readonly checkedAt: string;
}

function asAddress(value: unknown): Address {
  return String(value).toLowerCase() as Address;
}

function asAmount(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt(String(value));
}

function legFor(
  chain: "base" | "reactive",
  log: DecodedLog,
  timestamps: Map<string, number>,
): LedgerLegView {
  const config = chain === "base" ? BASE_SEPOLIA : REACTIVE_LASNA;
  return {
    txHash: log.transactionHash,
    chainId: config.id,
    blockNumber: log.blockNumber.toString(),
    timestamp: timestamps.get(`${chain}:${log.blockNumber}`) ?? 0,
    explorerUrl: config.txPath(log.transactionHash),
  };
}

async function timestampsFor(
  chain: "base" | "reactive",
  logs: readonly DecodedLog[],
  cache: Map<string, number>,
): Promise<void> {
  const blocks = [...new Set(logs.map((log) => log.blockNumber))];
  await Promise.all(
    blocks.map(async (block) => {
      const key = `${chain}:${block}`;
      if (cache.has(key)) return;
      try {
        cache.set(key, await getBlockTimestamp(chain, block));
      } catch {
      }
    }),
  );
}

interface DepositEvent {
  readonly burner: Address;
  readonly token: Address;
  readonly from: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
  claimed: boolean;
}

interface ReactiveEvent {
  readonly burner: Address;
  readonly token: Address;
  readonly coldWallet: Address | null;
  readonly amount: bigint;
  readonly originBlockNumber: bigint | null;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

interface SweepEvent {
  readonly burner: Address;
  readonly token: Address;
  readonly coldWallet: Address;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly leg: LedgerLegView;
}

function emptyIndex(
  error: string | undefined,
  config: ReturnType<typeof readDeploymentConfig>,
  verification: DeploymentVerification,
  configured: boolean,
): LedgerIndex {
  return {
    configured,
    verified: false,
    error,
    rsc: config.rscAddress,
    forwarder: config.forwarderAddress,
    token: config.tokenAddress,
    rows: [],
    counts: { complete: 0, reactiveOnly: 0, orphanSweep: 0 },
    window: { baseFrom: null, baseTo: null, reactiveFrom: null, reactiveTo: null },
    heads: { base: null, reactive: null },
    verification,
    checkedAt: new Date().toISOString(),
  };
}

async function buildIndex(burners: readonly Address[]): Promise<LedgerIndex> {
  const config = readDeploymentConfig();
  const verification = await verifyDeployment();

  if (config.rscAddress === null || config.forwarderAddress === null || config.tokenAddress === null) {
    return emptyIndex(
      "Deployment addresses are not configured. Set them in .env.local or run scripts/deploy-live.sh.",
      config,
      verification,
      false,
    );
  }

  if (!verification.verified) {
    const failed = verification.checks
      .filter((check) => check.hasCode !== true)
      .map((check) => `${check.name}: ${check.error ?? "no code"}`)
      .join("; ");
    return emptyIndex(
      `Configured addresses have no contract code. ${failed}`,
      config,
      verification,
      true,
    );
  }

  const rsc = contractTarget("rsc");
  const forwarder = contractTarget("forwarder");
  const token = contractTarget("token");

  const [baseHead, reactiveHead] = await Promise.all([
    readHead("base").catch(() => null),
    readHead("reactive").catch(() => null),
  ]);

  const baseFrom =
    config.forwarderDeployBlock ??
    (baseHead !== null && baseHead > DEFAULT_LEDGER_LOOKBACK ? baseHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const reactiveFrom =
    config.rscDeployBlock ??
    (reactiveHead !== null && reactiveHead > DEFAULT_LEDGER_LOOKBACK ? reactiveHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const baseTo = baseHead ?? 0n;
  const reactiveTo = reactiveHead ?? 0n;

  const timestampCache = new Map<string, number>();
  const eventErrors: string[] = [];

  const sweepLogs =
    baseTo >= baseFrom
      ? await getLogsChunked({
          client: forwarder.client,
          address: forwarder.address,
          event: TOKENS_SWEPT,
          fromBlock: baseFrom,
          toBlock: baseTo,
        }).catch(() => {
          eventErrors.push("TokensSwept logs unavailable");
          return [] as DecodedLog[];
        })
      : [];

  const purgeLogs =
    reactiveTo >= reactiveFrom
      ? await getLogsChunked({
          client: rsc.client,
          address: rsc.address,
          event: PURGE_TRIGGERED,
          fromBlock: reactiveFrom,
          toBlock: reactiveTo,
        }).catch(() => {
          eventErrors.push("PurgeTriggered logs unavailable");
          return [] as DecodedLog[];
        })
      : [];

  const callbackLogs =
    reactiveTo >= reactiveFrom
      ? await getLogsChunked({
          client: rsc.client,
          address: SYSTEM_CONTRACT,
          event: CALLBACK_REQUEST,
          args: { recipient: forwarder.address },
          fromBlock: reactiveFrom,
          toBlock: reactiveTo,
        }).catch(() => {
          return [] as DecodedLog[];
        })
      : [];

  const allBurners = [
    ...new Set([
      ...burners.map((burner) => burner.toLowerCase() as Address),
      ...sweepLogs.map((log) => asAddress(log.args.burner)),
      ...purgeLogs.map((log) => asAddress(log.args.burner)),
    ]),
  ];

  const depositLogs =
    baseTo >= baseFrom && allBurners.length > 0
      ? (
          await Promise.all(
            allBurners.map((burner) =>
              getLogsChunked({
                client: token.client,
                address: config.tokenAddress as Address,
                event: TRANSFER,
                args: { to: burner },
                fromBlock: baseFrom,
                toBlock: baseTo,
              }).catch(() => [] as DecodedLog[]),
            ),
          )
        ).flat()
      : [];

  await Promise.all([
    timestampsFor("base", depositLogs, timestampCache),
    timestampsFor("base", sweepLogs, timestampCache),
    timestampsFor("reactive", purgeLogs, timestampCache),
    timestampsFor("reactive", callbackLogs, timestampCache),
  ]);

  const deposits: DepositEvent[] = depositLogs
    .filter((log) => asAddress(log.args.to) !== forwarder.address)
    .map((log) => ({
      burner: asAddress(log.args.to),
      token: asAddress(log.args.token ?? config.tokenAddress),
      from: asAddress(log.args.from),
      amount: asAmount(log.args.value),
      blockNumber: log.blockNumber,
      leg: legFor("base", log, timestampCache),
      claimed: false,
    }))
    .filter((deposit) => deposit.amount > 0n)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.leg.txHash.localeCompare(b.leg.txHash)
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );

  const reactiveEvents: ReactiveEvent[] = purgeLogs
    .filter((log) => asAddress(log.args.token) === config.tokenAddress)
    .map((log) => ({
      burner: asAddress(log.args.burner),
      token: asAddress(log.args.token),
      coldWallet: asAddress(log.args.coldWallet),
      amount: asAmount(log.args.amount),
      originBlockNumber: asAmount(log.args.originBlockNumber),
      blockNumber: log.blockNumber,
      leg: legFor("reactive", log, timestampCache),
    }));

  const purgeTxHashes = new Set(purgeLogs.map((log) => log.transactionHash));
  for (const log of callbackLogs) {
    if (purgeTxHashes.has(log.transactionHash)) continue;
    const payload = decodeCallbackPayload(log.data ?? "0x");
    if (payload === "0x") continue;
    try {
      const decoded = decodeFunctionData({ abi: sapuForwarderAbi, data: payload });
      if (decoded.functionName !== "executeSweep") continue;
      const [, tokenArg, burnerArg, coldWalletArg, amountArg] = decoded.args as readonly [
        Address,
        Address,
        Address,
        Address,
        bigint,
      ];
      if (asAddress(tokenArg) !== config.tokenAddress) continue;
      reactiveEvents.push({
        burner: asAddress(burnerArg),
        token: asAddress(tokenArg),
        coldWallet: asAddress(coldWalletArg),
        amount: amountArg,
        originBlockNumber: null,
        blockNumber: log.blockNumber,
        leg: legFor("reactive", log, timestampCache),
      });
    } catch {
    }
  }

  const sweeps: SweepEvent[] = sweepLogs
    .filter((log) => asAddress(log.args.token) === config.tokenAddress)
    .map((log) => ({
      burner: asAddress(log.args.burner),
      token: asAddress(log.args.token),
      coldWallet: asAddress(log.args.coldWallet),
      amount: asAmount(log.args.amount),
      blockNumber: log.blockNumber,
      leg: legFor("base", log, timestampCache),
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  const pending = new Map<string, DepositEvent[]>();
  for (const deposit of deposits) {
    const key = `${deposit.token}:${deposit.burner}`;
    const queue = pending.get(key) ?? [];
    queue.push(deposit);
    pending.set(key, queue);
  }

  const reactiveFor = (sweep: SweepEvent): ReactiveEvent | null => {
    let best: ReactiveEvent | null = null;
    for (const event of reactiveEvents) {
      if (event.token !== sweep.token || event.burner !== sweep.burner) continue;
      if (event.blockNumber > sweep.blockNumber) continue;
      if (best === null || event.blockNumber > best.blockNumber) best = event;
    }
    return best;
  };

  const rows: LedgerRow[] = [];

  for (const sweep of sweeps) {
    const key = `${sweep.token}:${sweep.burner}`;
    const queue = pending.get(key) ?? [];

    let index = queue.findIndex(
      (deposit) => !deposit.claimed && deposit.amount === sweep.amount && deposit.blockNumber <= sweep.blockNumber,
    );
    if (index === -1) {
      index = queue.findIndex((deposit) => !deposit.claimed && deposit.blockNumber <= sweep.blockNumber);
    }

    const reactive = reactiveFor(sweep);

    if (index === -1) {
      rows.push({
        id: sweep.leg.txHash,
        burner: sweep.burner,
        token: sweep.token,
        coldWallet: sweep.coldWallet,
        depositAmount: "0",
        sweptAmount: sweep.amount.toString(),
        deposit: null,
        reactive: reactive?.leg ?? null,
        sweep: sweep.leg,
        status: classifyLedger({ deposit: null, sweep: sweep.leg }),
        latencyMs: null,
      });
      continue;
    }

    const deposit = queue[index]!;
    deposit.claimed = true;
    rows.push({
      id: deposit.leg.txHash,
      burner: deposit.burner,
      token: deposit.token,
      coldWallet: sweep.coldWallet,
      depositAmount: deposit.amount.toString(),
      sweptAmount: sweep.amount.toString(),
      deposit: deposit.leg,
      reactive: reactive?.leg ?? null,
      sweep: sweep.leg,
      status: classifyLedger({ deposit: deposit.leg, sweep: sweep.leg }),
      latencyMs: ledgerLatencyMs(deposit.leg, sweep.leg),
    });
  }

  for (const deposit of deposits) {
    if (deposit.claimed) continue;

    const reactive =
      reactiveEvents.find(
        (event) =>
          event.token === deposit.token &&
          event.burner === deposit.burner &&
          event.originBlockNumber !== null &&
          event.originBlockNumber === deposit.blockNumber,
      ) ??
      reactiveEvents.find(
        (event) => event.token === deposit.token && event.burner === deposit.burner,
      ) ??
      null;

    let coldWallet = reactive?.coldWallet ?? null;
    if (coldWallet === null) {
      try {
        const route = await readRoute(rsc.address, deposit.token, deposit.burner);
        coldWallet = route.active ? route.coldWallet : null;
      } catch {
        coldWallet = null;
      }
    }

    rows.push({
      id: deposit.leg.txHash,
      burner: deposit.burner,
      token: deposit.token,
      coldWallet,
      depositAmount: deposit.amount.toString(),
      sweptAmount: null,
      deposit: deposit.leg,
      reactive: reactive?.leg ?? null,
      sweep: null,
      status: classifyLedger({ deposit: deposit.leg, sweep: null }),
      latencyMs: null,
    });
  }

  rows.sort((a, b) => {
    const aBlock = BigInt(a.sweep?.blockNumber ?? a.deposit?.blockNumber ?? "0");
    const bBlock = BigInt(b.sweep?.blockNumber ?? b.deposit?.blockNumber ?? "0");
    if (aBlock === bBlock) return a.id.localeCompare(b.id);
    return aBlock < bBlock ? 1 : -1;
  });

  return {
    configured: true,
    verified: true,
    error: eventErrors.length > 0 ? eventErrors.join("; ") : undefined,
    rsc: config.rscAddress,
    forwarder: config.forwarderAddress,
    token: config.tokenAddress,
    rows,
    counts: countLedger(rows),
    window: {
      baseFrom: baseHead === null ? null : baseFrom.toString(),
      baseTo: baseHead === null ? null : baseTo.toString(),
      reactiveFrom: reactiveHead === null ? null : reactiveFrom.toString(),
      reactiveTo: reactiveHead === null ? null : reactiveTo.toString(),
    },
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
  readonly key: string;
  readonly promise: Promise<LedgerIndex>;
}

let cache: CacheEntry | null = null;
const TTL_MS = 15_000;

export function loadLedgerIndex(burners: readonly Address[] = []): Promise<LedgerIndex> {
  const now = Date.now();
  const key = [...new Set(burners.map((burner) => burner.toLowerCase()))].sort().join(",");

  if (cache !== null && cache.key === key && now - cache.at < TTL_MS) return cache.promise;

  const promise = buildIndex(burners).catch((error) => {
    const config = readDeploymentConfig();
    return emptyIndex(
      error instanceof Error ? error.message : String(error),
      config,
      { configured: false, verified: false, checks: [] },
      false,
    );
  });

  cache = { at: now, key, promise };
  return promise;
}
