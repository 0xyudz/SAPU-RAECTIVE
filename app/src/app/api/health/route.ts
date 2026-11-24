import { NextResponse } from "next/server";
import { readDeploymentConfig, isFullyConfigured } from "@/config/chains";
import { rpcOverride } from "@/config/chain-rpc";
import { getOriginBlockNumber, getTokenDecimals, getTokenSymbol } from "@/infrastructure/chain-client";
import { verifyDeployment } from "@/infrastructure/contracts";
import { reactiveHead } from "@/infrastructure/reactive-rpc-client";
import { withRpcRetry } from "@/infrastructure/rpc-retry";
import type { Address } from "@/domain/burner-route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = readDeploymentConfig();
  const configured = isFullyConfigured(config);
  const verification = await verifyDeployment();

  const [originResult, reactiveResult] = await Promise.allSettled([
    withRpcRetry(getOriginBlockNumber),
    withRpcRetry(reactiveHead),
  ]);

  let token: { address: string; symbol: string; decimals: number } | null = null;
  let error: string | undefined;
  const warnings: string[] = [...verification.warnings];

  if (config.configurationError !== null) {
    error = config.configurationError;
  }

  if (config.tokenAddress) {
    const [symbolResult, decimalsResult] = await Promise.allSettled([
      withRpcRetry(() => getTokenSymbol(config.tokenAddress as Address)),
      withRpcRetry(() => getTokenDecimals(config.tokenAddress as Address)),
    ]);

    if (symbolResult.status === "fulfilled" && decimalsResult.status === "fulfilled") {
      token = {
        address: config.tokenAddress,
        symbol: symbolResult.value,
        decimals: decimalsResult.value,
      };
    } else if (verification.checks.every((check) => check.address?.toLowerCase() !== config.tokenAddress)) {
      // Only when the code check did not already report this address. A token with no code
      // fails `symbol()` too, and saying both would be one problem stated twice. The code
      // check's message is the more precise one (it distinguishes "no contract" from "no
      // answer"), so it wins.
      warnings.push(
        `Default token metadata at ${config.tokenAddress} did not answer. SAPU can still arm any ERC-20; fix or clear NEXT_PUBLIC_SAPU_TOKEN_ADDRESS so the Arm form stops pre-filling it.`,
      );
    }
  }

  // Naming the chain and the configured endpoint makes a failure actionable. An unset
  // endpoint is reported as configuration, not as "the chain is down".
  const describe = (chainId: number, name: string): string => {
    const url = rpcOverride(chainId);
    return url === null
      ? `${name} RPC is not configured — set NEXT_PUBLIC_RPC_URL_${chainId}`
      : `${name} RPC unreachable (${url})`;
  };

  if (originResult.status === "rejected" && !error) {
    error = describe(config.origin.id, config.origin.name);
  }
  if (reactiveResult.status === "rejected" && !error) {
    error = describe(config.reactive.id, config.reactive.name);
  }

  return NextResponse.json(
    {
      network: config.network,
      origin: { id: config.origin.id, name: config.origin.name },
      reactive: { id: config.reactive.id, name: config.reactive.name },
      originBlock: originResult.status === "fulfilled" ? originResult.value.toString() : null,
      reactiveBlock: reactiveResult.status === "fulfilled" ? reactiveResult.value.toString() : null,
      token,
      forwarder: config.forwarderAddress,
      rsc: config.rscAddress,
      configured,
      error,
      warnings,
      verification,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
