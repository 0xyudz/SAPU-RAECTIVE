export interface ProofTransaction {
  readonly hash: string;
  readonly chainId: number;
  readonly explorerUrl: string;
  readonly blockNumber: string;
  readonly gasUsed?: string;
  readonly label?: string;
}

export interface ProofContracts {
  readonly rsc?: string;
  readonly forwarder?: string;
  readonly token?: string;
}

export interface ProofRecord {
  readonly generatedAt: string;
  readonly latencyMs: number;
  readonly transactions: {
    readonly arm: ProofTransaction;
    readonly deposit: ProofTransaction;
    readonly callback?: ProofTransaction;
    readonly sweep: ProofTransaction;
  };
  readonly contracts?: ProofContracts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTransaction(value: unknown): ProofTransaction | null {
  if (!isObject(value)) return null;
  if (typeof value.hash !== "string" || !value.hash.startsWith("0x")) return null;
  if (typeof value.explorerUrl !== "string" || value.explorerUrl.length === 0) return null;
  if (typeof value.chainId !== "number") return null;
  if (typeof value.blockNumber !== "string") return null;
  return {
    hash: value.hash,
    chainId: value.chainId,
    explorerUrl: value.explorerUrl,
    blockNumber: value.blockNumber,
    gasUsed: typeof value.gasUsed === "string" ? value.gasUsed : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
  };
}

export function readProofRecord(value: unknown): ProofRecord | null {
  if (!isObject(value)) return null;
  if (typeof value.generatedAt !== "string") return null;
  if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs)) return null;
  if (!isObject(value.transactions)) return null;

  const arm = readTransaction(value.transactions.arm);
  const deposit = readTransaction(value.transactions.deposit);
  const sweep = readTransaction(value.transactions.sweep);
  if (arm === null || deposit === null || sweep === null) return null;
  const callback = readTransaction(value.transactions.callback);

  const contracts = isObject(value.contracts)
    ? {
        rsc: typeof value.contracts.rsc === "string" ? value.contracts.rsc : undefined,
        forwarder:
          typeof value.contracts.forwarder === "string" ? value.contracts.forwarder : undefined,
        token: typeof value.contracts.token === "string" ? value.contracts.token : undefined,
      }
    : undefined;

  return {
    generatedAt: value.generatedAt,
    latencyMs: value.latencyMs,
    transactions: { arm, deposit, sweep, ...(callback === null ? {} : { callback }) },
    contracts,
  };
}
