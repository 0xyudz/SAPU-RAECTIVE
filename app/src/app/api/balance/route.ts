import { NextResponse } from "next/server";
import { isAddress, type Address } from "@/domain/burner-route";
import { pairKey } from "@/domain/pair-key";
import { readDeploymentConfig } from "@/config/chains";
import { readTokenBalances } from "@/infrastructure/token-balances";
import { reasonOf } from "@/infrastructure/reason";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Live token balance of one burner.
 *
 * Why this exists next to `/api/ledger`: the ledger only knows burners that appear in the
 * route registry or in a sweep/purge log. A burner that was funded through the QR deposit
 * card but never armed has none of those, so it is invisible to the indexer — and that is
 * precisely the burner whose key is most dangerous to lose, because nothing on-chain will
 * ever move the balance out.
 *
 * `balance: null` means the read failed. It is never reported as `"0"`, because zero is a
 * claim about the chain and a failed read is not.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const burnerParam = url.searchParams.get("burner");
  const tokenParam = url.searchParams.get("token");

  if (!isAddress(burnerParam)) {
    return NextResponse.json({ error: "burner must be a valid address" }, { status: 400 });
  }

  const config = readDeploymentConfig();
  // The caller may name the token (the Arm view always does). The configured token is only the
  // fallback default, so a deployment without one is not a failure — but with no token at all
  // there is nothing to read, and saying so is better than reading a zero address.
  const tokenSource = isAddress(tokenParam) ? tokenParam : config.tokenAddress;
  if (!isAddress(tokenSource)) {
    return NextResponse.json(
      {
        error:
          "No token to read: pass ?token=0x… or set NEXT_PUBLIC_SAPU_TOKEN_ADDRESS as the default.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const burner = burnerParam.toLowerCase() as Address;
  const token = tokenSource.toLowerCase() as Address;

  try {
    const reads = await readTokenBalances([{ token, burner }], config.origin.id);
    const balance = reads.get(pairKey(token, burner)) ?? null;
    return NextResponse.json(
      {
        burner,
        token,
        // Base units as a decimal string, or null when the call failed.
        balance: balance === null ? null : balance.toString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { burner, token, balance: null, error: reasonOf(error) },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
