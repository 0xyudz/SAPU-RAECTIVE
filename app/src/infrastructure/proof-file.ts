import { readFile } from "node:fs/promises";
import path from "node:path";
import { readProofRecord, type ProofFileStatus, type ProofRecord } from "@/domain/proof";

// The type is declared in `domain/proof` because the distinction it draws is a domain fact, and
// because components may not import from `infrastructure/`. Re-exported here so callers that
// already depend on this module do not need a second import.
export type { ProofFileStatus };

export interface ProofFileResult {
  readonly proof: ProofRecord | null;
  readonly status: ProofFileStatus;
  readonly path: string;
  readonly error?: string;
}

/**
 * Candidate locations, most specific first.
 *
 * `process.cwd()` is the app directory under `next start` and `next dev`, but it is the
 * repository root when these modules are exercised from scripts, and Vercel's working directory
 * is its own. Rather than assume one, the candidates cover each layout and the first readable
 * file wins.
 */
function candidates(): string[] {
  const cwd = process.cwd();
  return [
    path.resolve(cwd, "..", "docs", "proof", "latest.json"),
    path.resolve(cwd, "docs", "proof", "latest.json"),
    path.resolve(cwd, "..", "..", "docs", "proof", "latest.json"),
  ];
}

export async function readProofFile(): Promise<ProofFileResult> {
  const paths = candidates();
  const attempted: string[] = [];
  let sawUnreadable: { path: string; error: string } | null = null;

  for (const candidate of paths) {
    attempted.push(candidate);
    let raw: string;
    try {
      // `candidate` is an absolute path resolved at runtime, so Turbopack cannot know the set
      // of files in advance and would otherwise trace the entire project into the server
      // bundle. The proof file is a single known JSON artefact read at request time, and
      // `next.config.ts` lists it in `outputFileTracingIncludes` so a traced deployment still
      // ships it.
      raw = await readFile(/* turbopackIgnore: true */ candidate, "utf8");
    } catch (error) {
      const code = isObject(error) && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENOENT") continue;
      // Present but unreadable: keep looking, but remember it so the caller can report a fault
      // instead of claiming nothing was ever recorded.
      sawUnreadable = {
        path: candidate,
        error: error instanceof Error ? error.message : String(error),
      };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      sawUnreadable = {
        path: candidate,
        error: `latest.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      };
      continue;
    }

    const proof = readProofRecord(parsed);
    if (proof === null) {
      sawUnreadable = {
        path: candidate,
        error: "latest.json is present but does not match the proof schema.",
      };
      continue;
    }

    return { proof, status: "read", path: candidate };
  }

  if (sawUnreadable !== null) {
    return {
      proof: null,
      status: "unreadable",
      path: sawUnreadable.path,
      error: sawUnreadable.error,
    };
  }

  return { proof: null, status: "missing", path: attempted[0] ?? "docs/proof/latest.json" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
