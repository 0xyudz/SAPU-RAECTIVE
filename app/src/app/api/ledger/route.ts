import { NextResponse } from "next/server";
import type { Address } from "@/domain/burner-route";
import { loadRouteIndex } from "@/infrastructure/route-indexer";
import { loadLedgerIndex } from "@/infrastructure/ledger-indexer";
import { readForwarderCapabilities } from "@/infrastructure/forwarder-capabilities";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const registry = await loadRouteIndex();
  const burners = [...new Set(registry.rows.map((row) => row.burner))] as Address[];
  const ledger = await loadLedgerIndex(burners);

  // Whether the *deployed* forwarder can rescue a residue at all. Probed separately
  // from the ledger so a capability read failure cannot make the ledger look empty;
  // `rescueSweep: null` means "unknown", which the UI shows as such.
  const capabilities =
    ledger.forwarder === null
      ? { rescueSweep: null }
      : await readForwarderCapabilities(ledger.forwarder);

  return NextResponse.json(
    {
      ...ledger,
      registryConfigured: registry.configured,
      registryError: registry.error,
      forwarderOwner: registry.forwarderOwner,
      capabilities,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
