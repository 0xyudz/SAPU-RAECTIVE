import type { Address, BaseUnits } from "@/domain/burner-route";
import type { ChainLeg, SweepReceipt } from "@/domain/sweep-receipt";
import { withReactiveLeg, withSweepLeg } from "@/domain/sweep-receipt";
import { chainById } from "@/config/chains";

export interface SweepObservationPort {
  findDeposits(params: {
    token: Address;
    burner: Address;
    fromBlock: bigint;
    toBlock: bigint | "latest";
  }): Promise<
    Array<{
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      topics: readonly `0x${string}`[];
      data: `0x${string}`;
    }>
  >;

  findCallbackRequests(params: {
    recipient: Address;
    fromBlock: bigint;
    toBlock?: bigint | "latest";
    lookbackBlocks?: bigint;
  }): Promise<
    Array<{
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      sender: Address;
      recipient: Address;
      payload: `0x${string}`;
      /**
       * `executeSweep` arguments recovered from the payload, when it is well-formed. This is
       * the authoritative link to a deposit: it names the exact token, burner, cold wallet
       * and amount, so two chains' clocks disagreeing cannot pair the wrong events.
       */
      decoded?: {
        token: Address;
        burner: Address;
        coldWallet: Address;
        amount: bigint;
      } | null;
    }>
  >;

  findSweeps(params: {
    forwarder: Address;
    burner?: Address;
    fromBlock: bigint;
    toBlock: bigint | "latest";
  }): Promise<
    Array<{
      txHash: `0x${string}`;
      blockNumber: bigint;
      logIndex: number;
      topics: readonly `0x${string}`[];
      data: `0x${string}`;
    }>
  >;

  getBlockTimestamp(chain: "origin" | "reactive", blockNumber: bigint): Promise<number>;
}

export interface WatchParams {
  readonly token: Address;
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly forwarder: Address;
  readonly fromBlock: bigint;
  /** Chain the token and the forwarder live on (event source and sweep destination). */
  readonly originChainId: number;
  /** Reactive chain that emits `CallbackRequest`. */
  readonly reactiveChainId: number;
  /**
   * First Reactive block worth scanning for `CallbackRequest`.
   *
   * Defaults to the reactive chain's own head minus a lookback, which is wrong for a
   * deployment older than that lookback: the callbacks it is looking for are then older
   * than the window and the reactive leg silently goes missing. Callers that know when
   * `SapuRSC` was deployed should pass that block.
   */
  readonly reactiveFromBlock?: bigint;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onUpdate: (receipts: readonly SweepReceipt[]) => void;
}

export async function observe(
  port: SweepObservationPort,
  params: WatchParams,
  existing: readonly SweepReceipt[],
): Promise<SweepReceipt[]> {
  const byDeposit = new Map(existing.map((r) => [r.id, r]));

  const deposits = await port.findDeposits({
    token: params.token,
    burner: params.burner,
    fromBlock: params.fromBlock,
    toBlock: "latest",
  });

  for (const log of deposits) {
    if (byDeposit.has(log.txHash)) continue;

    const timestamp = await port.getBlockTimestamp("origin", log.blockNumber);
    byDeposit.set(log.txHash, {
      id: log.txHash,
      burner: params.burner,
      coldWallet: params.coldWallet,
      token: params.token,
      tokenSymbol: params.tokenSymbol,
      tokenDecimals: params.tokenDecimals,
      depositAmount: decodeTransferAmount(log.data),
      sweptAmount: null,
      deposit: originLeg(params.originChainId, log.txHash, log.blockNumber, timestamp),
      reactive: null,
      sweep: null,
    });
  }

  const sweeps = await port.findSweeps({
    forwarder: params.forwarder,
    burner: params.burner,
    fromBlock: params.fromBlock,
    toBlock: "latest",
  });

  // A sweep can only settle a deposit that already existed. Matching purely by order
  // attached any sweep in the scan window to the oldest pending deposit, so a sweep from
  // an earlier deposit (or one that predates this deposit entirely) made a stalled loop
  // look complete — the exact opposite of what this receipt is used to prove.
  //
  // Both legs are on the same chain here, so block heights are comparable and the ordering
  // constraint is sound. Within that, an exact amount match wins, because a partial sweep
  // (`sweptAmount < depositAmount`) is a distinct fact from a full one.
  //
  // `pending` holds references to the receipts as they were read; attaching a leg replaces
  // the object in `byDeposit`, so a claimed id has to be tracked separately or the same
  // deposit could be matched twice.
  const claimed = new Set<`0x${string}`>();
  const pending = [...byDeposit.values()].filter((r) => r.sweep === null).sort(compareReceipts);

  for (const sweepLog of sweeps) {
    const amount = decodeSweptAmount(sweepLog.data);
    const eligible = (r: SweepReceipt): boolean =>
      !claimed.has(r.id) && BigInt(r.deposit.blockNumber) < sweepLog.blockNumber;
    const match =
      pending.find((r) => eligible(r) && BigInt(r.depositAmount) === BigInt(amount)) ??
      pending.find(eligible);
    if (!match) continue;
    claimed.add(match.id);

    const timestamp = await port.getBlockTimestamp("origin", sweepLog.blockNumber);
    const updated = withSweepLeg(
      match,
      originLeg(params.originChainId, sweepLog.txHash, sweepLog.blockNumber, timestamp),
      amount,
    );
    byDeposit.set(updated.id, updated);
  }

  const callbacks = await port.findCallbackRequests({
    recipient: params.forwarder,
    fromBlock: params.reactiveFromBlock ?? 0n,
    // Only used when no deployment block is known: keeps the scan bounded rather than
    // walking the reactive chain's whole history.
    lookbackBlocks: params.reactiveFromBlock === undefined ? 50_000n : undefined,
  });

  const awaitingReactive = [...byDeposit.values()].filter((r) => r.reactive === null).sort(compareReceipts);
  const reactiveClaimed = new Set<`0x${string}`>();

  for (const callback of callbacks.slice().reverse()) {
    const timestamp = await port.getBlockTimestamp("reactive", callback.blockNumber);

    // The payload names the exact token, burner, cold wallet and amount the RSC asked to
    // sweep, so it is used as the primary link. Timestamps are only a fallback: the two
    // chains' clocks are independent, and the live proof callback is stamped one second
    // *before* the deposit it swept — a strict time comparison would drop a genuine leg.
    const decoded = callback.decoded ?? null;
    const matches = (r: SweepReceipt): boolean => {
      if (reactiveClaimed.has(r.id)) return false;
      if (decoded === null) return r.deposit.timestamp <= timestamp;
      return (
        decoded.burner === r.burner.toLowerCase() &&
        decoded.token === r.token.toLowerCase() &&
        decoded.coldWallet === r.coldWallet.toLowerCase() &&
        decoded.amount === BigInt(r.depositAmount)
      );
    };

    const match = awaitingReactive.find(matches);
    if (!match) continue;
    reactiveClaimed.add(match.id);

    const reactiveChain = chainById(params.reactiveChainId);
    if (reactiveChain === null) {
      throw new Error(`Reactive chain ${params.reactiveChainId} is not in the supported chain table.`);
    }
    const leg: ChainLeg = {
      txHash: callback.txHash,
      chainId: reactiveChain.id,
      blockNumber: callback.blockNumber.toString(),
      timestamp,
      explorerUrl: reactiveChain.txPath(callback.txHash),
    };
    const updated = withReactiveLeg(match, leg);
    byDeposit.set(updated.id, updated);
  }

  return [...byDeposit.values()].sort(compareReceipts);
}

function compareReceipts(a: SweepReceipt, b: SweepReceipt): number {
  const aBlock = BigInt(a.deposit.blockNumber);
  const bBlock = BigInt(b.deposit.blockNumber);
  if (aBlock === bBlock) {
    return a.deposit.txHash.localeCompare(b.deposit.txHash);
  }
  return aBlock < bBlock ? -1 : 1;
}

function originLeg(
  chainId: number,
  txHash: `0x${string}`,
  blockNumber: bigint,
  timestamp: number,
): ChainLeg {
  const chain = chainById(chainId);
  if (chain === null) {
    throw new Error(`Origin chain ${chainId} is not in the supported chain table.`);
  }
  return {
    txHash,
    chainId: chain.id,
    blockNumber: blockNumber.toString(),
    timestamp,
    explorerUrl: chain.txPath(txHash),
  };
}

export function decodeTransferAmount(data: `0x${string}`): BaseUnits {
  if (data.length < 66) return "0";
  return BigInt(`0x${data.slice(2, 66)}`).toString();
}

export function decodeSweptAmount(data: `0x${string}`): BaseUnits {
  if (data.length < 66) return "0";
  return BigInt(`0x${data.slice(2, 66)}`).toString();
}
