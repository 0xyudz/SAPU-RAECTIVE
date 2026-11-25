import { NextResponse } from "next/server";
import { isAddress, type Address } from "@/domain/burner-route";
import { readDeploymentConfig } from "@/config/chains";
import { probeTokenMetadata } from "@/infrastructure/token-probe";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { headers: { "cache-control": "no-store" } } as const;

/**
 * `symbol()` and `decimals()` for an arbitrary ERC-20 on the configured origin chain.
 *
 * `/api/health` reports the token named by `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS`, which is only the
 * deployment's default. The contracts are token-agnostic — `SapuForwarder` keys its rules by
 * `(token, burner)` and `SapuRSC` subscribes with the token as the log filter — so the Arm view
 * arms whatever address the operator types. Using the configured token's metadata for a typed
 * address would record a route whose symbol and decimals describe a different asset, which is the
 * exact fabrication the guard in `armRoute` exists to prevent.
 *
 * It is not folded into `/api/balance` because balance needs a burner and metadata does not.
 * Folding them together left the symbol hint stuck on "reading…" until a burner was selected,
 * which is the wrong order for a form filled top-down.
 *
 * ## Failure shape
 *
 * `200` with `status: "not-erc20"` means the chain answered and the address does not describe
 * itself as an ERC-20 — a fact about the token, fixed by typing a different address. `502` with
 * `status: "unreachable"` means the read never completed — a fact about the network, fixed by
 * retrying. Reporting a 429 as "not an ERC-20" would blame the operator's token for a node's
 * rate limit.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");

  if (!isAddress(tokenParam)) {
    return NextResponse.json(
      { status: "invalid-request", error: "token must be a valid address" },
      { status: 400, ...NO_STORE },
    );
  }

  const token = tokenParam.toLowerCase() as Address;
  const chainId = readDeploymentConfig().origin.id;
  const probe = await probeTokenMetadata(token);

  switch (probe.kind) {
    case "read":
      return NextResponse.json(
        { token, chainId, status: "read", symbol: probe.symbol, decimals: probe.decimals },
        NO_STORE,
      );
    case "no-code":
      return NextResponse.json(
        { token, chainId, status: "no-code" },
        NO_STORE,
      );
    case "not-erc20":
      return NextResponse.json(
        { token, chainId, status: "not-erc20", reason: probe.reason },
        NO_STORE,
      );
    case "unreachable":
      return NextResponse.json(
        { token, chainId, status: "unreachable", error: probe.reason },
        { status: 502, ...NO_STORE },
      );
  }
}
