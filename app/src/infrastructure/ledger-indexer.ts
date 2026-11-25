import { decodeEventLog, decodeFunctionData, parseAbiItem, toEventSelector } from "viem";
import type { Address } from "@/domain/burner-route";
import {
  countLedger,
  residueOf,
  strandRiskOf,
  type LedgerCounts,
  type LedgerLegView,
  type LedgerRow,
} from "@/domain/ledger";
import {
  correlateLedger,
  type CorrelatedLedgerRow,
  type LedgerDeposit,
  type LedgerDust,
  type LedgerReactive,
  type LedgerSweep,
} from "@/domain/ledger-correlation";
import { classifyResidue, type ResidueSummary } from "@/domain/residue";
import { assessAllowance } from "@/domain/allowance";
import type { StrandRisk } from "@/domain/allowance";
import { explainStrand } from "@/domain/strand-cause";
import { chainById, SYSTEM_CONTRACT, readDeploymentConfig } from "@/config/chains";
import { DEFAULT_LEDGER_LOOKBACK } from "@/config/constants";
import { sapuForwarderAbi } from "@/config/abis";
import { contractTarget, verifyDeployment, type CodeCheck, type DeploymentVerification } from "./contracts";
import { createCachedLoader, type CachedLoader } from "./cache";
import { getRawLogs, type DecodedLog, type RawLog } from "./logs";
import { asAddress } from "./address";
import { reasonOf } from "./reason";
import { readHead, readRoute } from "./chain-reads";
import { readTokenBalances, readForwarderAllowances } from "./token-balances";
import { readTokenMetadata } from "./token-metadata";
import { readPreconditions, toPreconditions } from "./sweep-preconditions";
import { getBlockTimestamp } from "./chain-client";
import { getOriginClient } from "./rpc-clients";
import { decodeCallbackPayload } from "./reactive-rpc-client";
import { pairKey, type TokenBurnerPair } from "@/domain/pair-key";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const TOKENS_SWEPT = parseAbiItem(
  "event TokensSwept(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, address reactiveSender)",
);
const PURGE_TRIGGERED = parseAbiItem(
  "event PurgeTriggered(address indexed burner, address indexed token, address indexed coldWallet, uint256 amount, uint256 originBlockNumber)",
);
const DUST_IGNORED = parseAbiItem(
  "event DustIgnored(address indexed burner, address indexed token, uint256 amount)",
);
const CALLBACK_REQUEST = parseAbiItem(
  "event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, uint8 version, bytes configuration)",
);

export interface LedgerWindow {
  readonly originFrom: string | null;
  readonly originTo: string | null;
  readonly reactiveFrom: string | null;
  readonly reactiveTo: string | null;
}

export interface LedgerTokenMeta {
  readonly token: Address;
  readonly symbol: string | null;
  readonly decimals: number | null;
}

/**
 * Which legs of the loop were actually scanned, per chain.
 *
 * This is a structural flag rather than a regex over `index.error`. `index.error` is a
 * human-readable concatenation, and five different failures can appear in it (both head reads,
 * `TokensSwept`, `PurgeTriggered`, `CallbackRequest`, `Transfer`); a regex over it covers only
 * the cases someone remembered. A failed reactive **head** skips every reactive query, and
 * matching on two specific messages left the page asserting "no reactive proof" for every row,
 * while a failed `Transfer` scan made the counts read as a quiet ledger.
 *
 * A structural flag cannot drift from the code that sets it. `false` means "this chain's logs
 * were not scanned", which is a coverage hole and never a statement about activity.
 */
export interface LedgerScanCoverage {
  /** `PurgeTriggered`, `CallbackRequest` and `DustIgnored` were queried without error. */
  readonly reactiveEvents: boolean;
  /** `TokensSwept` and per-token `Transfer` deposits were queried without error. */
  readonly originEvents: boolean;
}

export interface LedgerIndex {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly rsc: Address | null;
  readonly forwarder: Address | null;
  /**
   * The default token from configuration, kept for compatibility with callers that need a
   * single address. It is NOT the set of tokens this index covers — that is `tokens`.
   */
  readonly token: Address | null;
  /**
   * Every token the ledger actually observed, discovered from the route registry's own events.
   *
   * This is the field that makes the ledger multi-token. It is derived, never configured: the
   * RSC already records which token each route was armed for, so a deployment that watches
   * three assets needs no `NEXT_PUBLIC_` entry per asset.
   */
  readonly tokens: readonly LedgerTokenMeta[];
  readonly rows: readonly LedgerRow[];
  readonly counts: LedgerCounts;
  /** Live burner balances, aggregated per (token, burner) position. */
  readonly residue: ResidueSummary;
  /** Funded positions the forwarder cannot fully move, aggregated per position. */
  readonly strandRisk: StrandRisk;
  readonly window: LedgerWindow;
  readonly heads: { readonly origin: string | null; readonly reactive: string | null };
  /** Which legs were actually scanned. `false` is a coverage hole, never an absence of activity. */
  readonly coverage: LedgerScanCoverage;
  readonly verification: DeploymentVerification;
  readonly checkedAt: string;
}

function asAmount(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt(String(value));
}

function decodeOne(log: RawLog, events: readonly unknown[]): { name: string; args: Record<string, unknown> } | null {
  const topic = log.topics[0];
  if (topic === undefined) return null;
  for (const event of events) {
    if (toEventSelector(event as never) !== topic) continue;
    try {
      const decoded = decodeEventLog({ abi: [event] as never, data: log.data, topics: log.topics as never });
      return { name: decoded.eventName ?? "", args: decoded.args as unknown as Record<string, unknown> };
    } catch {
      return null;
    }
  }
  return null;
}

function toDecoded(logs: readonly RawLog[], events: readonly unknown[]): DecodedLog[] {
  const out: DecodedLog[] = [];
  for (const log of logs) {
    const decoded = decodeOne(log, events);
    if (decoded === null) continue;
    out.push({
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      data: log.data,
      args: decoded.args,
    });
  }
  return out;
}

/**
 * The tokens to run `eth_getLogs` against.
 *
 * ## Why the configured default is filtered
 *
 * `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` is optional and only a fallback, so it is added here to keep
 * a deployment visible even when the registry scan came back empty. But it is added **only when
 * `eth_getCode` confirmed a contract at that address**.
 *
 * Adding it unconditionally meant a mistyped default became a `getLogs` filter against an
 * address with no code. Public gateways reject that with "Invalid parameters were provided to
 * the RPC method", which marked the entire origin leg uncovered — so one typo in an optional
 * setting blanked every deposit and sweep in the ledger. The registry's own events already name
 * the real tokens, so the scan loses nothing by dropping an address that is not a contract.
 */
export function scanTokens(
  discovered: readonly Address[],
  configuredToken: Address | null,
  checks: readonly CodeCheck[],
): Address[] {
  const tokens = new Set<string>(discovered.map((token) => token.toLowerCase()));

  if (configuredToken !== null) {
    const confirmed = checks.some(
      (check) =>
        check.address !== null &&
        check.address.toLowerCase() === configuredToken.toLowerCase() &&
        check.hasCode === true,
    );
    if (confirmed) tokens.add(configuredToken.toLowerCase());
  }

  return [...tokens] as Address[];
}

function legFor(
  chain: "origin" | "reactive",
  chainId: number,
  log: DecodedLog,
  timestamps: Map<string, number>,
): LedgerLegView {
  const config = chainById(chainId);
  if (config === null) {
    throw new Error(`Chain ${chainId} is not in the supported chain table.`);
  }
  return {
    txHash: log.transactionHash,
    chainId: config.id,
    blockNumber: log.blockNumber.toString(),
    timestamp: timestamps.get(`${chain}:${log.blockNumber}`) ?? 0,
    explorerUrl: config.txPath(log.transactionHash),
  };
}

async function timestampsFor(
  chain: "origin" | "reactive",
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
        // A missing timestamp only leaves the row's time unset; the amount, the burner and
        // the transaction hash all still come from the log itself. Failing the whole index
        // because one block header was unavailable would hide every row it did read.
      }
    }),
  );
}

interface DepositEvent extends LedgerDeposit {
  readonly from: Address;
}

type ReactiveEvent = LedgerReactive;
type SweepEvent = LedgerSweep;

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
    tokens: [],
    rows: [],
    counts: { complete: 0, reactiveOnly: 0, orphanSweep: 0 },
    residue: { heldBurners: 0, unreadBurners: 0, totals: [] },
    strandRisk: { atRiskBurners: 0, unknownBurners: 0 },
    window: { originFrom: null, originTo: null, reactiveFrom: null, reactiveTo: null },
    heads: { origin: null, reactive: null },
    // Nothing was scanned at all, so no leg is covered. Claiming `true` here would let the page
    // render "no deposits" for a deployment that was never read.
    coverage: { reactiveEvents: false, originEvents: false },
    verification,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Builds the ledger for the given positions.
 *
 * `positions` is the set of (token, burner) pairs the route registry discovered. It is the
 * source of truth for *which* tokens exist: the RSC records the token when a route is armed,
 * so the ledger follows the chain instead of a `NEXT_PUBLIC_` variable. A deployment watching
 * three assets needs no extra configuration, and a token the app was never told about still
 * shows up once a route for it is armed.
 */
async function buildIndex(positions: readonly TokenBurnerPair[]): Promise<LedgerIndex> {
  const config = readDeploymentConfig();
  const verification = await verifyDeployment();

  if (config.rscAddress === null || config.forwarderAddress === null) {
    return emptyIndex(
      "Deployment addresses are not configured. Set them in .env.local or run scripts/deploy-live.sh.",
      config,
      verification,
      false,
    );
  }

  if (!verification.verified) {
    const failed = verification.checks
      .filter((check) => check.required && check.hasCode !== true)
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

  const [originHeadRead, reactiveHeadRead] = await Promise.allSettled([readHead("origin"), readHead("reactive")]);

  const timestampCache = new Map<string, number>();
  const eventErrors: string[] = [];

  // Coverage is tracked as booleans next to the messages, because the page needs a fact, not a
  // substring of a human-readable sentence. See `LedgerScanCoverage`.
  let originEventsCovered = true;
  let reactiveEventsCovered = true;

  // One call site for "this leg was not scanned". Keeping the message and the coverage flag
  // together is the point: recording a failure without clearing the flag is how a failed scan
  // reads as a quiet, empty ledger.
  const recordUnscanned = (side: "origin" | "reactive", message: string): void => {
    eventErrors.push(message);
    if (side === "origin") originEventsCovered = false;
    else reactiveEventsCovered = false;
  };

  // A failed head read must never look like a quiet, empty ledger. Without the head there is
  // no scan window, so every event query below is skipped; that is a coverage hole, not an
  // absence of activity, and it is recorded as such before anything else runs.
  const originHead = originHeadRead.status === "fulfilled" ? originHeadRead.value : null;
  const reactiveHead = reactiveHeadRead.status === "fulfilled" ? reactiveHeadRead.value : null;

  if (originHead === null) {
    const reason = originHeadRead.status === "rejected" ? reasonOf(originHeadRead.reason) : "unknown";
    recordUnscanned("origin", `${config.origin.name} head unavailable, no origin logs were scanned (${reason})`);
  }
  if (reactiveHead === null) {
    const reason = reactiveHeadRead.status === "rejected" ? reasonOf(reactiveHeadRead.reason) : "unknown";
    recordUnscanned("reactive", `${config.reactive.name} head unavailable, no reactive logs were scanned (${reason})`);
  }

  const originFrom =
    config.forwarderDeployBlock ??
    (originHead !== null && originHead > DEFAULT_LEDGER_LOOKBACK ? originHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const reactiveFrom =
    config.rscDeployBlock ??
    (reactiveHead !== null && reactiveHead > DEFAULT_LEDGER_LOOKBACK ? reactiveHead - DEFAULT_LEDGER_LOOKBACK : 0n);
  const originTo = originHead ?? 0n;
  const reactiveTo = reactiveHead ?? 0n;

  const sweepLogs = await (async (): Promise<DecodedLog[]> => {
    if (originTo < originFrom) return [];
    try {
      const raw = await getRawLogs({
        client: forwarder.client,
        address: forwarder.address,
        fromBlock: originFrom,
        toBlock: originTo,
        cacheKeySuffix: "forwarder-events",
      });
      return toDecoded(raw, [TOKENS_SWEPT]);
    } catch (error) {
      recordUnscanned("origin", `TokensSwept logs unavailable (${reasonOf(error)})`);
      return [];
    }
  })();

  const [purgeLogs, callbackLogs, dustLogs] =
    reactiveTo >= reactiveFrom
      ? await (async () => {
          const [rscResult, callbackResult] = await Promise.allSettled([
            getRawLogs({
              client: rsc.client,
              address: rsc.address,
              fromBlock: reactiveFrom,
              toBlock: reactiveTo,
              cacheKeySuffix: "rsc-events",
            }),
            getRawLogs({
              client: rsc.client,
              address: SYSTEM_CONTRACT,
              fromBlock: reactiveFrom,
              toBlock: reactiveTo,
              cacheKeySuffix: "callback-events",
              event: CALLBACK_REQUEST,
              // Filter at the node instead of downloading every system-contract event and
              // discarding almost all of them. Measured on Lasna: unfiltered 2,779 ms for 1,045
              // events, filtered 749 ms for the same page. The recipient filter is also what
              // the `.filter` below enforces, so the two cannot disagree.
              args: { recipient: forwarder.address },
            }),
          ]);

          if (rscResult.status === "rejected") {
            recordUnscanned("reactive", `PurgeTriggered logs unavailable (${reasonOf(rscResult.reason)})`);
          }
          if (callbackResult.status === "rejected") {
            recordUnscanned("reactive", `CallbackRequest logs unavailable (${reasonOf(callbackResult.reason)})`);
          }

          // One RSC log scan, decoded twice. `toDecoded` selects by topic, so passing both
          // event shapes to one call would lose which one matched; two passes keep the
          // purge rows and the dust rows distinct without a second `eth_getLogs`.
          const rscLogs = rscResult.status === "fulfilled" ? rscResult.value : [];
          return [
            toDecoded(rscLogs, [PURGE_TRIGGERED]),
            // Kept as a second line of defence: the node filtered by recipient, but a node that
            // ignores the filter must not be able to inject another deployment's callbacks into
            // these rows.
            callbackResult.status === "fulfilled"
              ? toDecoded(callbackResult.value, [CALLBACK_REQUEST]).filter(
                  (log) => asAddress(log.args.recipient) === forwarder.address,
                )
              : [],
            toDecoded(rscLogs, [DUST_IGNORED]),
          ] as const;
        })()
      : ([[], [], []] as const);

  const allBurners = [
    ...new Set([
      ...positions.map((position) => position.burner.toLowerCase() as Address),
      ...sweepLogs.map((log) => asAddress(log.args.burner)),
      ...purgeLogs.map((log) => asAddress(log.args.burner)),
      // A deposit below the dust floor emits no `PurgeTriggered`, so this is the only event
      // that names its burner. Leaving it out would drop the burner's transfer from the scan.
      ...dustLogs.map((log) => asAddress(log.args.burner)),
    ]),
  ];
  const burnerSet = new Set<string>(allBurners);

  // Which tokens to scan transfers for. The registry's own events are the authority; the
  // configured token is only a fallback so a deployment whose registry scan came back empty
  // still shows the asset it was told about.
  const tokenSet = new Set<string>();
  for (const position of positions) tokenSet.add(position.token.toLowerCase());
  for (const log of sweepLogs) tokenSet.add(asAddress(log.args.token));
  for (const log of purgeLogs) tokenSet.add(asAddress(log.args.token));
  for (const log of dustLogs) tokenSet.add(asAddress(log.args.token));
  const tokens = scanTokens(
    [...tokenSet] as Address[],
    config.tokenAddress,
    verification.checks,
  );

  // One `eth_getLogs` per token, because `Transfer` carries no token in its topics and the
  // only way to attribute a transfer to an asset is the emitting contract's address.
  // Filtering a single token's log stream and then labelling every row with that token is
  // exactly the bug this loop removes.
  //
  // Both topics are filtered at the node. Asking for every log the token ever emitted and
  // discarding all but the handful addressed to a known burner is unbounded work: measured on
  // Base Sepolia, a single 1,000-block chunk of WETH's unfiltered `Transfer` stream came back as
  // 10,499,600 bytes — over viem's 10 MB response cap — so the request failed, the whole origin
  // leg was marked unscanned, and the ledger claimed there were no deposits for *any* token.
  // Filtering `Transfer` alone was not enough either: the USDC gateway still rejected that window
  // with "Invalid parameters were provided to the RPC method".
  //
  // Filtering the recipient as well is both correct and cheap. `Transfer`'s `to` is indexed, so
  // `args: { to: burners }` becomes a topic OR-list the node applies before serialising anything;
  // the same three tokens then answered in 0.8–1.2 s with 0, 0 and 28 logs. The `.filter` below
  // stays as a second line of defence, because a node that ignores the filter must not be able
  // to inject transfers to unrelated addresses into these rows.
  const depositLogs: DecodedLog[] = [];
  if (originTo >= originFrom && allBurners.length > 0 && tokens.length > 0) {
    const results = await Promise.allSettled(
      tokens.map(async (tokenAddress) => {
        const decoded = toDecoded(
          await getRawLogs({
            client: getOriginClient(),
            address: tokenAddress,
            fromBlock: originFrom,
            toBlock: originTo,
            cacheKeySuffix: "token-transfers",
            event: TRANSFER,
            args: { to: allBurners },
          }),
          [TRANSFER],
        );
        return decoded
          .filter((log) => burnerSet.has(asAddress(log.args.to)))
          .map((log) => ({ log, token: tokenAddress }));
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        recordUnscanned("origin", `Transfer logs unavailable, deposits not scanned (${reasonOf(result.reason)})`);
        continue;
      }
      for (const entry of result.value) {
        // The token is the emitting contract, which is the only reliable attribution.
        depositLogs.push({ ...entry.log, args: { ...entry.log.args, token: entry.token } });
      }
    }
  }

  await Promise.all([
    timestampsFor("origin", depositLogs, timestampCache),
    timestampsFor("origin", sweepLogs, timestampCache),
    timestampsFor("reactive", purgeLogs, timestampCache),
    timestampsFor("reactive", callbackLogs, timestampCache),
    timestampsFor("reactive", dustLogs, timestampCache),
  ]);

  const deposits: DepositEvent[] = depositLogs
    .filter((log) => asAddress(log.args.to) !== forwarder.address)
    .map((log) => ({
      burner: asAddress(log.args.to),
      token: asAddress(log.args.token),
      from: asAddress(log.args.from),
      amount: asAmount(log.args.value),
      blockNumber: log.blockNumber,
      leg: legFor("origin", config.origin.id, log, timestampCache),
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
    .filter((log) => tokenSet.has(asAddress(log.args.token)))
    .map((log) => ({
      burner: asAddress(log.args.burner),
      token: asAddress(log.args.token),
      coldWallet: asAddress(log.args.coldWallet),
      amount: asAmount(log.args.amount),
      originBlockNumber: asAmount(log.args.originBlockNumber),
      blockNumber: log.blockNumber,
      leg: legFor("reactive", config.reactive.id, log, timestampCache),
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
      if (!tokenSet.has(asAddress(tokenArg))) continue;
      reactiveEvents.push({
        burner: asAddress(burnerArg),
        token: asAddress(tokenArg),
        coldWallet: asAddress(coldWalletArg),
        amount: amountArg,
        originBlockNumber: null,
        blockNumber: log.blockNumber,
        leg: legFor("reactive", config.reactive.id, log, timestampCache),
      });
    } catch {
      // The callback payload is calldata copied out of a log; it is not guaranteed to be a
      // well-formed `executeSweep`. Anything else is some other call this indexer does not
      // model, so skipping it is correct — but it must not abort the sweep rows below.
    }
  }

  const sweeps: SweepEvent[] = sweepLogs
    .filter((log) => tokenSet.has(asAddress(log.args.token)))
    .map((log) => ({
      burner: asAddress(log.args.burner),
      token: asAddress(log.args.token),
      coldWallet: asAddress(log.args.coldWallet),
      amount: asAmount(log.args.amount),
      blockNumber: log.blockNumber,
      leg: legFor("origin", config.origin.id, log, timestampCache),
    }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  const dustEvents: LedgerDust[] = dustLogs
    .filter((log) => tokenSet.has(asAddress(log.args.token)))
    .map((log) => ({
      burner: asAddress(log.args.burner),
      token: asAddress(log.args.token),
      amount: asAmount(log.args.amount),
      blockNumber: log.blockNumber,
      leg: legFor("reactive", config.reactive.id, log, timestampCache),
    }));

  const correlated = correlateLedger({ deposits, reactiveEvents, sweeps, dustEvents });

  // `correlateLedger` is pure: when a deposit's reactive event did not name the destination,
  // it leaves the cold wallet null rather than reading the chain. Filling that gap is the
  // indexer's job, and it only touches the rows that actually need it.
  const rows: CorrelatedLedgerRow[] = [];
  for (const row of correlated) {
    if (row.coldWallet !== null || row.sweep !== null) {
      rows.push(row);
      continue;
    }
    let coldWallet: Address | null = null;
    try {
      const route = await readRoute(rsc.address, row.token as Address, row.burner as Address);
      coldWallet = route.active ? route.coldWallet : null;
    } catch {
      coldWallet = null;
    }
    rows.push({ ...row, coldWallet });
  }

  const holders: TokenBurnerPair[] = rows.map((row) => ({
    token: row.token as Address,
    burner: row.burner as Address,
  }));

  // Both reads are batched through the same multicall so a page load does not fan out into two
  // requests per position. Running them together also means the allowance is judged against the
  // balance observed in the same block, not one scan apart.
  const [balances, allowances, preconditions, metadata] = await Promise.all([
    readTokenBalances(holders, config.origin.id),
    readForwarderAllowances(holders, config.origin.id),
    readPreconditions({
      forwarder: forwarder.address,
      rsc: rsc.address,
      pairs: holders,
      originChainId: config.origin.id,
      reactiveChainId: config.reactive.id,
    }),
    readTokenMetadata(tokens, config.origin.id),
  ]);

  const withResidue: LedgerRow[] = rows.map((row) => {
    const key = pairKey(row.token as Address, row.burner as Address);
    const liveBalance = balances.get(key) ?? null;
    const residue = classifyResidue({
      liveBalance,
      depositAmount: row.depositAmount,
      sweptAmount: row.sweptAmount,
    });
    const allowance = assessAllowance({ allowance: allowances.get(key) ?? null, liveBalance });
    const reads = preconditions.get(key);
    const cause = explainStrand({
      residue: residue.state,
      dustIgnored: row.dustIgnored,
      preconditions:
        reads === undefined
          ? { allowance: allowance.state, forwarderArmed: null, rscActive: null, coldWalletAgrees: null }
          : toPreconditions(reads, allowance.state),
    });

    return {
      ...row,
      residue,
      allowance,
      cause,
      // The live rule's destination, so the rescue preflight can name what the contract will
      // actually use. Null when the rule is unarmed or unreadable — the rescue is then blocked,
      // and `rescueAvailability` says why.
      liveColdWallet: reads?.forwarderColdWallet ?? null,
    };
  });

  return {
    configured: true,
    verified: eventErrors.length === 0,
    error: eventErrors.length > 0 ? eventErrors.join("; ") : undefined,
    rsc: config.rscAddress,
    forwarder: config.forwarderAddress,
    token: config.tokenAddress,
    tokens: tokens
      .map((tokenAddress) => {
        const meta = metadata.get(tokenAddress.toLowerCase() as Address);
        return {
          token: tokenAddress,
          symbol: meta?.symbol ?? null,
          decimals: meta?.decimals ?? null,
        };
      })
      .sort((a, b) => a.token.localeCompare(b.token)),
    rows: withResidue,
    counts: countLedger(withResidue),
    residue: residueOf(withResidue),
    strandRisk: strandRiskOf(withResidue),
    window: {
      originFrom: originHead === null ? null : originFrom.toString(),
      originTo: originHead === null ? null : originTo.toString(),
      reactiveFrom: reactiveHead === null ? null : reactiveFrom.toString(),
      reactiveTo: reactiveHead === null ? null : reactiveTo.toString(),
    },
    heads: {
      origin: originHead?.toString() ?? null,
      reactive: reactiveHead?.toString() ?? null,
    },
    coverage: {
      reactiveEvents: reactiveEventsCovered,
      originEvents: originEventsCovered,
    },
    verification,
    checkedAt: new Date().toISOString(),
  };
}

function emptyLedgerIndex(error: unknown): LedgerIndex {
  return emptyIndex(
    error instanceof Error ? error.message : String(error),
    readDeploymentConfig(),
    { configured: false, verified: false, checks: [], warnings: [] },
    false,
  );
}

/**
 * One loader per position set.
 *
 * The key changes whenever the route registry gains or loses a (token, burner) position, and
 * each loader holds a whole `LedgerIndex`. Bounded so a long-lived server cannot accumulate one
 * index per historical position set: evicting a loader only means the next request rebuilds it.
 */
const ledgerLoaders = new Map<string, CachedLoader<LedgerIndex>>();
const LEDGER_LOADERS_MAX = 4;

export function loadLedgerIndex(positions: readonly TokenBurnerPair[] = []): Promise<LedgerIndex> {
  const key = [...new Set(positions.map((position) => pairKey(position.token, position.burner)))]
    .sort()
    .join(",");
  let loader = ledgerLoaders.get(key);
  if (loader === undefined) {
    loader = createCachedLoader<LedgerIndex>({
      build: () => buildIndex(positions).catch(emptyLedgerIndex),
      freshMs: 8_000,
      staleMs: 120_000,
    });
    if (ledgerLoaders.size >= LEDGER_LOADERS_MAX) {
      const oldest = ledgerLoaders.keys().next();
      if (oldest.done !== true) ledgerLoaders.delete(oldest.value);
    }
    ledgerLoaders.set(key, loader);
  }
  return loader.load();
}
