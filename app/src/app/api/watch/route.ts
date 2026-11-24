import { NextResponse } from "next/server";
import { readDeploymentConfig } from "@/config/chains";
import { DEFAULT_LEDGER_LOOKBACK } from "@/config/constants";
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
import {
  buildWatchWindow,
  describeWatchWindow,
  observe,
  type SweepObservationPort,
  type WatchWindowSource,
} from "@/application/sweep-orchestrator";

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
    // Tolerated rather than fatal: an explicit `fromBlock` does not need the head, and a head
    // read failure must not turn a valid request into a 502. `null` is reported as "unknown" in
    // the window instead of being substituted with a number the node never gave us.
    const head = await getOriginBlockNumber().catch(() => null);

    // The default window used to be `head - 5_000`, which is not a search of the deployment:
    // the live swept burners are ~1.7M blocks behind the head, so the endpoint answered
    // `receipts: []` for a sweep the ledger had already classified as complete. A default must
    // cover everything the deployment could have produced, otherwise its empty answer is a
    // claim about the chain that the scan never tested. The deploy block is that bound; the
    // lookback is only the fallback for a deployment that never recorded one.
    let fromBlock: bigint;
    let originFromSource: WatchWindowSource;
    if (explicitFromBlock !== null) {
      fromBlock = explicitFromBlock;
      originFromSource = "explicit";
    } else if (config.forwarderDeployBlock !== null) {
      fromBlock = config.forwarderDeployBlock;
      originFromSource = "deploy-block";
    } else {
      fromBlock = head !== null && head > DEFAULT_LEDGER_LOOKBACK ? head - DEFAULT_LEDGER_LOOKBACK : 0n;
      originFromSource = "lookback";
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

    // Report the window alongside the receipts. `receipts: []` on its own is ambiguous — it
    // could mean "no deposit ever" or "the scan started too late" — and this endpoint has
    // already answered the second case as if it were the first.
    const window = buildWatchWindow({
      originFrom: fromBlock,
      originHead: head,
      originFromSource,
      deployBlock: config.forwarderDeployBlock,
      reactiveFrom: config.rscDeployBlock,
    });

    return NextResponse.json(
      { receipts, window, summary: describeWatchWindow(window, receipts.length) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "watch failed", receipts: [] },
      { status: 502 },
    );
  }
}
