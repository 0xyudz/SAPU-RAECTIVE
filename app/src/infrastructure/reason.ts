export function reasonOf(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;

    for (const field of ["shortMessage", "details", "message"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.trim() !== "") {
        const first = value.split("\n")[0]!.trim();
        if (first !== "" && !/^RPC Request failed\.?$/i.test(first)) return first;
      }
    }

    current = record.cause;
  }

  return error instanceof Error ? error.message : String(error);
}
