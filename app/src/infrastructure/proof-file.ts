import { readFile } from "node:fs/promises";
import path from "node:path";
import { readProofRecord, type ProofRecord } from "@/domain/proof";

export interface ProofFileResult {
  readonly proof: ProofRecord | null;
  readonly path: string;
  readonly error?: string;
}

async function candidates(): Promise<string[]> {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, "..", "docs", "proof", "latest.json"),
    path.resolve(cwd, "docs", "proof", "latest.json"),
    path.resolve(cwd, "..", "..", "docs", "proof", "latest.json"),
  ];
}

export async function readProofFile(): Promise<ProofFileResult> {
  const paths = await candidates();
  const attempted: string[] = [];

  for (const candidate of paths) {
    attempted.push(candidate);
    try {
      // `candidate` is an absolute path resolved at runtime, so Turbopack cannot know the set
      // of files in advance and would otherwise trace the entire project into the server
      // bundle. The proof file is a single known JSON artefact read at request time.
      const raw = await readFile(/* turbopackIgnore: true */ candidate, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const proof = readProofRecord(parsed);
      if (proof === null) {
        return {
          proof: null,
          path: candidate,
          error: "docs/proof/latest.json is present but does not match the proof schema.",
        };
      }
      return { proof, path: candidate };
    } catch (error) {
      const code = isObject(error) && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") continue;
      return {
        proof: null,
        path: candidate,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { proof: null, path: attempted[0] ?? "docs/proof/latest.json" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
