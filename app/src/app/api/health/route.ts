/**
 * GET /api/health
 *
 * Reports real chain heads and the configured contract addresses. The client uses
 * this both for the consensus pulse and to decide whether the loop is deployable.
 *
 * This route never touches a private key and never writes to the chain.
 */

import { NextResponse } from "next/server";
import { readDeploymentConfig, isFullyConfigured, BASE_SEPOLIA, REACTIVE_LASNA } from "@/config/chains";
import { getTokenDecimals, getTokenSymbol, getBaseSepoliaBlockNumber } from "@/infrastructure/base-sepolia-client";
import { reactiveHead } from "@/infrastructure/reactive-rpc-client";
import type { Address } from "@/domain/burner-route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = readDeploymentConfig();
  const configured = isFullyConfigured(config);

  // Chain heads are fetched independently so one unreachable RPC cannot blank the
  // whole health response — the UI should show "lasna unreachable" rather than die.
  const [baseResult, reactiveResult] = await Promise.allSettled([
    getBaseSepoliaBlockNumber(),
    reactiveHead(),
  ]);

  let token: { address: string; symbol: string; decimals: number } | null = null;
  let error: string | undefined;

  if (config.tokenAddress) {
    const [symbolResult, decimalsResult] = await Promise.allSettled([
      getTokenSymbol(config.tokenAddress as Address),
      getTokenDecimals(config.tokenAddress as Address),
    ]);

    if (symbolResult.status === "fulfilled" && decimalsResult.status === "fulfilled") {
      token = {
        address: config.tokenAddress,
        symbol: symbolResult.value,
        decimals: decimalsResult.value,
      };
    } else {
      error = "token metadata unavailable — check NEXT_PUBLIC_SAPU_TOKEN_ADDRESS";
    }
  }

  if (baseResult.status === "rejected" && !error) {
    error = `Base Sepolia RPC unreachable (${BASE_SEPOLIA.rpcUrl})`;
  }
  if (reactiveResult.status === "rejected" && !error) {
    error = `Reactive Lasna RPC unreachable (${REACTIVE_LASNA.rpcUrl})`;
  }

  return NextResponse.json(
    {
      baseBlock: baseResult.status === "fulfilled" ? baseResult.value.toString() : null,
      reactiveBlock: reactiveResult.status === "fulfilled" ? reactiveResult.value.toString() : null,
      token,
      forwarder: config.forwarderAddress,
      rsc: config.rscAddress,
      configured,
      error,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
