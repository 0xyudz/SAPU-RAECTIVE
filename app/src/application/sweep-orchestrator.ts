import type { Address, BaseUnits } from "@/domain/burner-route";
import type { ChainLeg, SweepReceipt } from "@/domain/sweep-receipt";
import { withReactiveLeg, withSweepLeg, isComplete } from "@/domain/sweep-receipt";
import { BASE_SEPOLIA, REACTIVE_LASNA } from "@/config/chains";

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

  getBlockTimestamp(chain: "base" | "reactive", blockNumber: bigint): Promise<number>;
}

export interface WatchParams {
  readonly token: Address;
  readonly burner: Address;
  readonly coldWallet: Address;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly forwarder: Address;
  readonly fromBlock: bigint;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onUpdate: (receipts: readonly SweepReceipt[]) => void;
}

export function watchBurner(port: SweepObservationPort, params: WatchParams): () => void {
  const interval = params.pollIntervalMs ?? 3_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let receipts: SweepReceipt[] = [];

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  params.signal?.addEventListener("abort", stop, { once: true });

  const poll = async (): Promise<void> => {
    if (stopped) return;

    try {
      receipts = await observe(port, params, receipts);
      if (stopped) return;
      params.onUpdate(receipts);
    } catch (error) {
      if (stopped) return;
      params.onUpdate(receipts);
      void error;
    }

    if (!stopped) {
      timer = setTimeout(poll, interval);
    }
  };

  void poll();

  return stop;
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

    const timestamp = await port.getBlockTimestamp("base", log.blockNumber);
    byDeposit.set(log.txHash, {
      id: log.txHash,
      burner: params.burner,
      coldWallet: params.coldWallet,
      token: params.token,
      tokenSymbol: params.tokenSymbol,
      tokenDecimals: params.tokenDecimals,
      depositAmount: decodeTransferAmount(log.data),
      sweptAmount: null,
      deposit: baseLeg(log.txHash, log.blockNumber, timestamp),
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

  const pending = [...byDeposit.values()].filter((r) => r.sweep === null).sort(compareReceipts);

  for (const sweepLog of sweeps) {
    const amount = decodeSweptAmount(sweepLog.data);
    const match = pending.find((r) => r.sweep === null);
    if (!match) break;

    const timestamp = await port.getBlockTimestamp("base", sweepLog.blockNumber);
    const updated = withSweepLeg(match, baseLeg(sweepLog.txHash, sweepLog.blockNumber, timestamp), amount);
    byDeposit.set(updated.id, updated);
  }

  const callbacks = await port.findCallbackRequests({
    recipient: params.forwarder,
    fromBlock: 0n,
    lookbackBlocks: 50_000n,
  });

  const awaitingReactive = [...byDeposit.values()].filter((r) => r.reactive === null).sort(compareReceipts);

  for (const callback of callbacks.slice().reverse()) {
    const match = awaitingReactive.find((r) => r.reactive === null);
    if (!match) break;

    const timestamp = await port.getBlockTimestamp("reactive", callback.blockNumber);
    const leg: ChainLeg = {
      txHash: callback.txHash,
      chainId: REACTIVE_LASNA.id,
      blockNumber: callback.blockNumber.toString(),
      timestamp,
      explorerUrl: REACTIVE_LASNA.txPath(callback.txHash),
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

function baseLeg(txHash: `0x${string}`, blockNumber: bigint, timestamp: number): ChainLeg {
  return {
    txHash,
    chainId: BASE_SEPOLIA.id,
    blockNumber: blockNumber.toString(),
    timestamp,
    explorerUrl: BASE_SEPOLIA.txPath(txHash),
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

export function incompleteCount(receipts: readonly SweepReceipt[]): number {
  return receipts.filter((r) => !isComplete(r)).length;
}
