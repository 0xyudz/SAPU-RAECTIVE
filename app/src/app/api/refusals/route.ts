import { NextResponse } from "next/server";
import type { Address } from "@/domain/burner-route";
import { readDeploymentConfig } from "@/config/chains";
import { REFUSAL_PROBES } from "@/config/constants";
import { runRefusalLab, type RefusalInput } from "@/application/refusal-lab";
import { createRefusalSimulator } from "@/infrastructure/refusal-simulator";
import { loadRouteIndex } from "@/infrastructure/route-indexer";
import { readOwner, readTokenBalance } from "@/infrastructure/chain-reads";
import { pairKey, probeToken, selectRefusalPairs } from "@/domain/refusal-pairs";

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

    const fallbackPair = { burner: nonOwner as Address, coldWallet: nonOwner as Address };

    // Which token to probe, and which pairs to probe it with. This used to be two independent
    // choices: the burner came from any row with `forwarderArmed`, while the token came from
    // configuration. Because armedness is a property of `(token, burner)`, a burner armed only
    // for USDC could be simulated against SAPU — producing `RouteNotArmed` where the card
    // promised `NothingToSweep`. `selectRefusalPairs` names the token once and derives every
    // pair from rows that belong to it.
    const candidates = registry.rows.map((row) => ({
      token: row.token,
      burner: row.burner,
      forwarderArmed: row.forwarderArmed,
      coldWallet: row.forwarderColdWallet ?? row.rscColdWallet,
    }));

    const probe = probeToken(candidates, config.tokenAddress);

    // Balances are read per (token, burner) for the token being probed, so the "zero balance"
    // pair is one whose balance was actually read for *this* asset.
    const armedForToken = candidates.filter(
      (row) => row.forwarderArmed && row.token.toLowerCase() === probe.toLowerCase(),
    );
    const balanceEntries = await Promise.all(
      armedForToken.map(
        async (row) =>
          [
            pairKey(row.token, row.burner),
            await readTokenBalance(row.token, row.burner).catch(() => null),
          ] as const,
      ),
    );

    const pairs = selectRefusalPairs(
      candidates,
      probe,
      new Map(balanceEntries),
      fallbackPair,
    );

    const input: RefusalInput = {
      rsc: config.rscAddress,
      forwarder: config.forwarderAddress,
      // The probed token, not the configured one: every case below is simulated against the
      // asset its burner is actually paired with.
      token: probe,
      callbackProxy: config.callbackProxy,
      nonOwner,
      disarmedBurner: pairs.disarmed.burner,
      disarmedColdWallet: pairs.disarmed.coldWallet,
      zeroBalanceBurner: pairs.zeroBalance?.burner ?? pairs.disarmed.burner,
      zeroBalanceColdWallet: pairs.zeroBalance?.coldWallet ?? pairs.disarmed.coldWallet,
    };

    const rawCases = await runRefusalLab(createRefusalSimulator(), input);
    const cases =
      pairs.zeroBalance === null
        ? rawCases.map((item) =>
            item.id === "zero-balance" && item.decodedName === "RouteNotArmed"
              ? {
                  ...item,
                  detail:
                    "No armed route exists for this token yet, so executeSweep reverted earlier at RouteNotArmed. Arm one route (with 0 burner balance) to observe NothingToSweep directly.",
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
        token: probe,
        pairs: {
          disarmed: pairs.disarmed,
          zeroBalance: pairs.zeroBalance,
          disarmedIsSynthetic: pairs.disarmedIsSynthetic,
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
