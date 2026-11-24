import { NextResponse } from "next/server";
import { readDeploymentConfig } from "@/config/chains";
import { isAddress, type Address } from "@/domain/burner-route";
import {
  findDeposits,
  findSweeps,
  getBlockTimestamp,
  getOriginBlockNumber,
  getTokenDecimals,
  getTokenSymbol,
} from "@/infrastructure/chain-client";
import { findCallbackRequests } from "@/infrastructure/reactive-rpc-client";
import { observe, type SweepObservationPort } from "@/application/sweep-orchestrator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const livePort: SweepObservationPort = {
  findDeposits,
  findCallbackRequests,
  findSweeps,
  getBlockTimestamp,
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const burnerParam = url.searchParams.get("burner");
  const tokenParam = url.searchParams.get("token");
  const coldParam = url.searchParams.get("cold");
  const fromBlockParam = url.searchParams.get("fromBlock");

  if (!isAddress(burnerParam) || !isAddress(tokenParam) || !isAddress(coldParam)) {
    return NextResponse.json({ error: "burner, token and cold must be valid addresses" }, { status: 400 });
  }

  const config = readDeploymentConfig();
  if (!config.forwarderAddress) {
    return NextResponse.json({ error: "forwarder not configured" }, { status: 503 });
  }

  const burner = burnerParam.toLowerCase() as Address;
  const token = tokenParam.toLowerCase() as Address;
  const cold = coldParam.toLowerCase() as Address;

  // Parse the caller-supplied block before the try block: `BigInt("abc")` throws, and letting
  // that reach the catch below answered a malformed *request* with a 502, which reads as
  // "the node failed" rather than "your input is invalid". A negative or absurd height is
  // rejected for the same reason — `eth_getLogs` would fail and be misreported as a node fault.
  let explicitFromBlock: bigint | null = null;
  if (fromBlockParam !== null && fromBlockParam !== "latest") {
    if (!/^\d+$/.test(fromBlockParam.trim())) {
      return NextResponse.json(
        { error: "fromBlock must be a decimal block number or \"latest\"", receipts: [] },
        { status: 400 },
      );
    }
    explicitFromBlock = BigInt(fromBlockParam.trim());
  }

  try {
    let fromBlock: bigint;
    if (explicitFromBlock === null) {
      const head = await getOriginBlockNumber();
      fromBlock = head > 5_000n ? head - 5_000n : 0n;
    } else {
      fromBlock = explicitFromBlock;
    }

    const [symbol, decimals] = await Promise.all([
      getTokenSymbol(token).catch(() => config.tokenSymbol),
      getTokenDecimals(token).catch(() => config.tokenDecimals),
    ]);

    const receipts = await observe(
      livePort,
      {
        token,
        burner,
        coldWallet: cold,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        forwarder: config.forwarderAddress,
        fromBlock,
        originChainId: config.origin.id,
        reactiveChainId: config.reactive.id,
        // Anchor the callback scan to the RSC deployment when it is known. Without this
        // the scan only covers the last 50,000 Reactive blocks, so any callback older
        // than that is invisible and the receipt's reactive leg is silently dropped.
        reactiveFromBlock: config.rscDeployBlock ?? undefined,
        onUpdate: () => {},
      },
      [],
    );

    return NextResponse.json(
      { receipts },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "watch failed", receipts: [] },
      { status: 502 },
    );
  }
}
