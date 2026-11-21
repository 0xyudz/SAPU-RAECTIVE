import { NextResponse } from "next/server";
import { readDeploymentConfig } from "@/config/chains";
import { isAddress, type Address } from "@/domain/burner-route";
import {
  findDeposits,
  findSweeps,
  getBlockTimestamp,
  getBaseSepoliaBlockNumber,
  getTokenDecimals,
  getTokenSymbol,
} from "@/infrastructure/base-sepolia-client";
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

  try {
    let fromBlock: bigint;
    if (fromBlockParam === "latest" || fromBlockParam === null) {
      const head = await getBaseSepoliaBlockNumber();
      fromBlock = head > 5_000n ? head - 5_000n : 0n;
    } else {
      fromBlock = BigInt(fromBlockParam);
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
