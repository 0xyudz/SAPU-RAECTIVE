import type { Address } from "@/domain/burner-route";

/**
 * Serialises a burner key into a downloadable backup.
 *
 * This is the *opt-in* escape hatch, not the default, and it exists because a burner key held
 * only in memory dies with the tab: if that burner holds a balance the loss is permanent, since
 * an address cannot be turned back into a key and `rescueSweep` needs the burner's own signature
 * to grant a fresh allowance.
 *
 * It is not automatic because SAPU exists to stop the burner from being linked to its owner, and
 * a key file in a downloads folder is a durable, often cloud-synced, written link between the
 * two. The caller must therefore ask for it explicitly, and the payload says what it is so a
 * future reader understands the risk instead of finding an unexplained hex string.
 *
 * The JSON is intentionally a plain, self-describing record: no encryption, no
 * passphrase. Encryption here would be security theatre — the key is already in the
 * clear in the browser's memory, and a fake sense of protection invites careless storage.
 */
export interface BurnerBackup {
  readonly kind: "sapu-burner-backup";
  readonly version: 1;
  readonly address: Address;
  readonly privateKey: `0x${string}`;
  readonly chainId: number;
  readonly createdAt: string;
  readonly warning: string;
}

export function buildBurnerBackup(params: {
  readonly address: Address;
  readonly privateKey: `0x${string}`;
  readonly chainId: number;
  readonly now?: Date;
}): BurnerBackup {
  return {
    kind: "sapu-burner-backup",
    version: 1,
    address: params.address,
    privateKey: params.privateKey,
    chainId: params.chainId,
    createdAt: (params.now ?? new Date()).toISOString(),
    warning:
      "Anyone holding this private key controls this burner and can move everything in it. " +
      "It also links you to this burner, which is exactly what SAPU otherwise avoids. " +
      "Store it offline, never in cloud storage, and delete it once the burner is empty.",
  };
}

/** Suggested filename, so several backups do not overwrite each other. */
export function backupFileName(address: Address, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `sapu-burner-${address.slice(0, 10)}-${stamp}.json`;
}

export function serialiseBackup(backup: BurnerBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Parses a backup the user pasted or re-opened, refusing anything ambiguous.
 *
 * A wrong key here would silently create an empty burner that looks like the funded one,
 * so every field that identifies the burner is checked rather than trusted.
 */
export function parseBurnerBackup(raw: string): BurnerBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("That file does not contain a burner backup object.");
  }

  const record = parsed as Record<string, unknown>;
  if (record.kind !== "sapu-burner-backup") {
    throw new Error('That file is not a SAPU burner backup (missing "kind": "sapu-burner-backup").');
  }
  if (record.version !== 1) {
    throw new Error(`Unsupported backup version ${String(record.version)}; this build understands version 1.`);
  }
  if (typeof record.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(record.address)) {
    throw new Error("The backup has no valid burner address.");
  }
  if (typeof record.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.privateKey)) {
    throw new Error("The backup has no valid 32-byte private key.");
  }

  return {
    kind: "sapu-burner-backup",
    version: 1,
    address: record.address.toLowerCase() as Address,
    privateKey: record.privateKey as `0x${string}`,
    chainId: typeof record.chainId === "number" ? record.chainId : 0,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    warning: typeof record.warning === "string" ? record.warning : "",
  };
}
