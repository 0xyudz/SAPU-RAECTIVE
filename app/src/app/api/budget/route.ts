import { NextResponse } from "next/server";
import { readDeploymentConfig } from "@/config/chains";
import { readOwner } from "@/infrastructure/chain-reads";
import { readBudget } from "@/infrastructure/budget-reader";
import { verifyDeployment } from "@/infrastructure/contracts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = readDeploymentConfig();
  const verification = await verifyDeployment();

  if (config.rscAddress === null || config.forwarderAddress === null) {
    return NextResponse.json(
      {
        configured: false,
        verified: false,
        error: "Deployment addresses are not configured. Set them in .env.local or run scripts/deploy-live.sh.",
        verification,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  if (!verification.verified) {
    return NextResponse.json(
      {
        configured: true,
        verified: false,
        error: "A configured address has no contract code. Nothing may be rendered against it.",
        verification,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const [budget, rscOwner, forwarderOwner] = await Promise.all([
      readBudget(config.rscAddress, config.forwarderAddress),
      readOwner("rsc"),
      readOwner("forwarder"),
    ]);

    return NextResponse.json(
      {
        configured: true,
        verified: true,
        budget: {
          callbackGasLimit: budget.callbackGasLimit.toString(),
          rscBalance: budget.rscBalance.toString(),
          forwarderBalance: budget.forwarderBalance.toString(),
          gasPrice: budget.gasPrice.toString(),
          rscDebt: budget.rscDebt.toString(),
          forwarderDebt: budget.forwarderDebt.toString(),
          sweepsRemaining: budget.budget.sweepsRemaining.toString(),
          costPerSweepWei: budget.budget.costPerSweepWei.toString(),
        },
        owners: { rsc: rscOwner, forwarder: forwarderOwner },
        verification,
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
        verification,
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
