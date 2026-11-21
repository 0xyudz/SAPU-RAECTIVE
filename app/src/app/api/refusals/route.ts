import { NextResponse } from "next/server";
import type { Address } from "@/domain/burner-route";
import { readDeploymentConfig } from "@/config/chains";
import { REFUSAL_PROBES } from "@/config/constants";
import { runRefusalLab, type RefusalInput } from "@/application/refusal-lab";
import { createRefusalSimulator } from "@/infrastructure/refusal-simulator";
import { loadRouteIndex } from "@/infrastructure/route-indexer";
import { readOwner, readTokenBalance } from "@/infrastructure/chain-reads";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = readDeploymentConfig();
  const registry = await loadRouteIndex();

  if (config.rscAddress === null || config.forwarderAddress === null || config.tokenAddress === null) {
    return NextResponse.json(
      {
        configured: false,
        verified: false,
        error: "Deployment addresses are not configured. Set them in .env.local or run scripts/deploy-live.sh.",
        cases: [],
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!registry.verified) {
    return NextResponse.json(
      {
        configured: true,
        verified: false,
        error: registry.error ?? "Configured addresses have no contract code.",
        cases: [],
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const [rscOwner, forwarderOwner] = await Promise.all([readOwner("rsc"), readOwner("forwarder")]);
    const nonOwner =
      REFUSAL_PROBES.find(
        (candidate) =>
          candidate.toLowerCase() !== rscOwner && candidate.toLowerCase() !== forwarderOwner,
      ) ?? REFUSAL_PROBES[0]!;

    const disarmedRow = registry.rows.find((row) => !row.forwarderArmed);
    const disarmedBurner = (disarmedRow?.burner ?? nonOwner) as Address;
    const disarmedColdWallet = (disarmedRow?.rscColdWallet ??
      disarmedRow?.forwarderColdWallet ??
      nonOwner) as Address;

    const armedRows = registry.rows.filter((row) => row.forwarderArmed);
    const balances = await Promise.all(
      armedRows.map(async (row) => ({
        row,
        balance: await readTokenBalance(config.tokenAddress as Address, row.burner).catch(() => null),
      })),
    );
    const zeroBalanceRow =
      balances.find((entry) => entry.balance === 0n)?.row ??
      balances.find((entry) => entry.row.diagnosis.status === "agree")?.row ??
      null;

    const zeroBalanceBurner = (zeroBalanceRow?.burner ?? disarmedBurner) as Address;
    const zeroBalanceColdWallet = (zeroBalanceRow?.forwarderColdWallet ??
      zeroBalanceRow?.rscColdWallet ??
      disarmedColdWallet) as Address;

    const input: RefusalInput = {
      rsc: config.rscAddress,
      forwarder: config.forwarderAddress,
      token: config.tokenAddress,
      callbackProxy: config.callbackProxy,
      nonOwner,
      disarmedBurner,
      disarmedColdWallet,
      zeroBalanceBurner,
      zeroBalanceColdWallet,
    };

    const rawCases = await runRefusalLab(createRefusalSimulator(), input);
    const cases =
      zeroBalanceRow === null
        ? rawCases.map((item) =>
            item.id === "zero-balance" && item.decodedName === "RouteNotArmed"
              ? {
                  ...item,
                  detail:
                    "No armed route exists in the registry yet, so executeSweep reverted earlier at RouteNotArmed. Arm one route (with 0 burner balance) to observe NothingToSweep directly.",
                }
              : item,
          )
        : rawCases;

    return NextResponse.json(
      {
        configured: true,
        verified: true,
        cases,
        callers: { nonOwner, callbackProxy: config.callbackProxy },
        pairs: {
          disarmed: { burner: disarmedBurner, coldWallet: disarmedColdWallet },
          zeroBalance: { burner: zeroBalanceBurner, coldWallet: zeroBalanceColdWallet },
        },
        checkedAt: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        configured: true,
        verified: true,
        error: error instanceof Error ? error.message : String(error),
        cases: [],
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
