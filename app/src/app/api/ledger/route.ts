import { NextResponse } from "next/server";
import { loadRouteIndex } from "@/infrastructure/route-indexer";
import { loadLedgerIndex } from "@/infrastructure/ledger-indexer";
import { readForwarderCapabilities } from "@/infrastructure/forwarder-capabilities";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const registry = await loadRouteIndex();

  // The registry is the authority for which (token, burner) positions exist: it discovers them
  // from the RSC's own `RouteRegistered`/`RouteArmed` events. Passing the pairs rather than a
  // flat burner list is what makes the ledger multi-token — the same burner armed for two
  // assets contributes two positions, and a token the app was never configured with still
  // appears once a route for it exists on chain.
  const positions = registry.rows.map((row) => ({ token: row.token, burner: row.burner }));
  const ledger = await loadLedgerIndex(positions);

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
