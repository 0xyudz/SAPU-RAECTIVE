import { NextResponse } from "next/server";
import { loadRouteIndex } from "@/infrastructure/route-indexer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const index = await loadRouteIndex();
  return NextResponse.json(index, { headers: { "cache-control": "no-store" } });
}
