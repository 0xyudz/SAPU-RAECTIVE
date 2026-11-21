import { NextResponse } from "next/server";
import type { Address } from "@/domain/burner-route";
import { loadRouteIndex } from "@/infrastructure/route-indexer";
import { loadLedgerIndex } from "@/infrastructure/ledger-indexer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const registry = await loadRouteIndex();
  const burners = [...new Set(registry.rows.map((row) => row.burner))] as Address[];
  const ledger = await loadLedgerIndex(burners);
  return NextResponse.json(
    { ...ledger, registryConfigured: registry.configured, registryError: registry.error },
    { headers: { "cache-control": "no-store" } },
  );
}
