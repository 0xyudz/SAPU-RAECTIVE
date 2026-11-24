import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readProofFile } from "@/infrastructure/proof-file";

/**
 * The landing page must be able to tell "no run has been recorded" apart from "the record exists
 * but this process could not read it".
 *
 * ## The bug this pins
 *
 * `readProofFile` returned `proof: null` for every failure mode, and the landing page answered
 * `null` with developer instructions: "run `bash scripts/e2e-demo.sh` with funded testnet keys".
 * On a traced deployment (Vercel ships only traced files) the JSON was not present, so the page
 * silently dropped all four proof cards — the strongest evidence on the page — and replaced them
 * with a shell command aimed at whoever was reading.
 *
 * Those are different situations and they deserve different words:
 *
 *   - `missing`     a fresh checkout with no live run yet. A state, not a fault.
 *   - `unreadable`  a file that is there but cannot be read, parsed, or validated. A fault.
 *
 * These tests drive the real function against a real temporary directory. Nothing is mocked: the
 * `readFile` call, the JSON parse and the schema validation are all the production path. The
 * working directory is redirected because that is the only input the function takes, and it is
 * restored afterwards so a failure here cannot leak into another file.
 */

const ORIGINAL_CWD = process.cwd();

let root = "";

const validProof = {
  generatedAt: "2026-11-24T06:49:12.241Z",
  latencyMs: 1000,
  transactions: {
    arm: {
      hash: "0x8d99214ab8ff118aa534e4cacc4a1b6660bedce6b18f650d3d4f84015e1ad14a",
      chainId: 5318007,
      explorerUrl: "https://lasna.reactscan.net/tx/0x8d99214a",
      blockNumber: "9106287",
    },
    deposit: {
      hash: "0x9719e22b15dcbac8e48be20a86ae4fdef37fcebd4a17440ca4b6b896b425d389",
      chainId: 84532,
      explorerUrl: "https://sepolia.basescan.org/tx/0x9719e22b",
      blockNumber: "62905349",
    },
    callback: {
      hash: "0x7a21c62b53f5d2d84c91e61d3a3ad430b58de4dc50c36029751dc885569825ca",
      chainId: 5318007,
      explorerUrl: "https://lasna.reactscan.net/tx/0x7a21c62b",
      blockNumber: "9117741",
    },
    sweep: {
      hash: "0x5fce361813f12f3d3d6b9cfecf14453220f142326463eb5dbbd000bd87985d18",
      chainId: 84532,
      explorerUrl: "https://sepolia.basescan.org/tx/0x5fce3618",
      blockNumber: "62905353",
    },
  },
};

/** The path the production code reads first when `process.cwd()` is the app directory. */
function proofPath(): string {
  return path.resolve(root, "app", "..", "docs", "proof", "latest.json");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sapu-proof-"));
  await mkdir(path.join(root, "app"), { recursive: true });
  await mkdir(path.join(root, "docs", "proof"), { recursive: true });
  process.chdir(path.join(root, "app"));
});

afterAll(async () => {
  process.chdir(ORIGINAL_CWD);
  await rm(root, { recursive: true, force: true });
});

describe("readProofFile status", () => {
  it("reports `read` and returns the record when the file is valid", async () => {
    await writeFile(proofPath(), JSON.stringify(validProof), "utf8");

    const result = await readProofFile();

    expect(result.status).toBe("read");
    expect(result.error).toBeUndefined();
    expect(result.proof).not.toBeNull();
    expect(result.proof?.latencyMs).toBe(1000);
    expect(result.proof?.transactions.callback?.chainId).toBe(5318007);
  });

  it("reports `missing` — not `unreadable` — when no file exists at all", async () => {
    await rm(proofPath(), { force: true });

    const result = await readProofFile();

    expect(result.status).toBe("missing");
    expect(result.proof).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("reports `unreadable` when the file exists but is not valid JSON", async () => {
    await writeFile(proofPath(), "{ not json", "utf8");

    const result = await readProofFile();

    expect(result.status).toBe("unreadable");
    expect(result.proof).toBeNull();
    expect(result.error).toContain("not valid JSON");
  });

  it("reports `unreadable` when the file parses but does not match the proof schema", async () => {
    await writeFile(proofPath(), JSON.stringify({ generatedAt: "x", latencyMs: "fast" }), "utf8");

    const result = await readProofFile();

    expect(result.status).toBe("unreadable");
    expect(result.proof).toBeNull();
    expect(result.error).toContain("does not match the proof schema");
  });

  it("reports `unreadable` when the path is a directory rather than a file", async () => {
    await rm(proofPath(), { force: true });
    await mkdir(proofPath(), { recursive: true });

    try {
      const result = await readProofFile();

      expect(result.status).toBe("unreadable");
      expect(result.proof).toBeNull();
      expect(result.error).toBeTruthy();
    } finally {
      await rm(proofPath(), { recursive: true, force: true });
    }
  });

  it("still reports `read` after recovering from an unreadable file", async () => {
    await writeFile(proofPath(), JSON.stringify(validProof), "utf8");

    const result = await readProofFile();

    expect(result.status).toBe("read");
    expect(result.proof).not.toBeNull();
  });
});
