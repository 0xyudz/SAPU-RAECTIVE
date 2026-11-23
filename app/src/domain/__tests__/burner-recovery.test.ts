import { describe, expect, it } from "vitest";
import {
  assertSignatureBelongsTo,
  assertUsableScalar,
  BurnerDerivationError,
  derivationMessage,
} from "@/domain/burner-derivation";
import { backupFileName, buildBurnerBackup, parseBurnerBackup, serialiseBackup } from "@/domain/burner-backup";
import type { Address } from "@/domain/burner-route";

const ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const KEY = `0x${"ab".repeat(32)}` as `0x${string}`;
const SIG = `0x${"cd".repeat(65)}` as `0x${string}`;

describe("derivationMessage", () => {
  it("is deterministic and names the index", () => {
    expect(derivationMessage(0)).toBe(derivationMessage(0));
    expect(derivationMessage(0)).toContain("Burner index: 0");
    expect(derivationMessage(7)).toContain("Burner index: 7");
  });

  it("differs per index, so one wallet yields unlinkable burners", () => {
    expect(derivationMessage(0)).not.toBe(derivationMessage(1));
  });

  it("states that it is not a transaction", () => {
    expect(derivationMessage(0)).toContain("not a transaction");
  });

  it("rejects a negative or fractional index rather than silently coercing", () => {
    expect(() => derivationMessage(-1)).toThrow(BurnerDerivationError);
    expect(() => derivationMessage(1.5)).toThrow(BurnerDerivationError);
  });
});

describe("assertSignatureBelongsTo", () => {
  it("accepts a signature that recovers to the expected signer", () => {
    expect(() =>
      assertSignatureBelongsTo({ signature: SIG, signer: ADDRESS, recovered: ADDRESS.toUpperCase().replace("0X", "0x") }),
    ).not.toThrow();
  });

  it("rejects a signature from a different account", () => {
    expect(() =>
      assertSignatureBelongsTo({
        signature: SIG,
        signer: ADDRESS,
        recovered: "0x2222222222222222222222222222222222222222",
      }),
    ).toThrow(/Refusing to derive a key/);
  });

  it("rejects a signature that is not 65 bytes", () => {
    expect(() =>
      assertSignatureBelongsTo({ signature: "0xdead", signer: ADDRESS, recovered: ADDRESS }),
    ).toThrow(/65-byte signature/);
  });
});

describe("assertUsableScalar", () => {
  it("accepts a normal 32-byte scalar", () => {
    expect(() => assertUsableScalar(KEY)).not.toThrow();
  });

  it("rejects the zero scalar, which would be an account nobody controls", () => {
    expect(() => assertUsableScalar(`0x${"00".repeat(32)}`)).toThrow(/zero/);
  });

  it("rejects a wrong-length value", () => {
    expect(() => assertUsableScalar("0xabcd")).toThrow(/32-byte scalar/);
  });
});

describe("burner backup round-trip", () => {
  it("serialises and parses back to the same key and address", () => {
    const backup = buildBurnerBackup({ address: ADDRESS, privateKey: KEY, chainId: 84532 });
    const restored = parseBurnerBackup(serialiseBackup(backup));
    expect(restored.address).toBe(ADDRESS);
    expect(restored.privateKey).toBe(KEY);
    expect(restored.chainId).toBe(84532);
  });

  it("carries a warning, so the file explains its own risk", () => {
    const backup = buildBurnerBackup({ address: ADDRESS, privateKey: KEY, chainId: 84532 });
    expect(backup.warning).toContain("controls this burner");
  });

  it("refuses a file that is not a SAPU backup", () => {
    expect(() => parseBurnerBackup('{"kind":"something-else"}')).toThrow(/not a SAPU burner backup/);
  });

  it("refuses an unknown version instead of guessing", () => {
    const raw = JSON.stringify({ kind: "sapu-burner-backup", version: 99, address: ADDRESS, privateKey: KEY });
    expect(() => parseBurnerBackup(raw)).toThrow(/Unsupported backup version/);
  });

  it("refuses invalid JSON", () => {
    expect(() => parseBurnerBackup("not json")).toThrow(/not valid JSON/);
  });

  it("refuses a malformed private key", () => {
    const raw = JSON.stringify({ kind: "sapu-burner-backup", version: 1, address: ADDRESS, privateKey: "0x1234" });
    expect(() => parseBurnerBackup(raw)).toThrow(/valid 32-byte private key/);
  });

  it("names the file by address and timestamp so backups do not overwrite", () => {
    const name = backupFileName(ADDRESS, new Date("2026-01-02T03:04:05Z"));
    expect(name).toContain("0x11111111");
    expect(name).toContain("2026-01-02");
    expect(name.endsWith(".json")).toBe(true);
  });
});
