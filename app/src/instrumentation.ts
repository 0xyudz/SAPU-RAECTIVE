import { getClient } from "@/infrastructure/rpc-clients";
import { readDeploymentConfig } from "@/config/chains";

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const warm = (label: string, run: () => Promise<unknown>) => {
    void run().catch(() => {
      void label;
    });
  };

  // Warm both sides of whichever deployment is configured. `getClient` throws when no RPC
  // endpoint is set, which is a configuration state the routes already report honestly;
  // here it must not crash startup.
  const config = readDeploymentConfig();
  for (const chainId of [config.origin.id, config.reactive.id]) {
    try {
      const client = getClient(chainId);
      warm(String(chainId), () => client.getBlockNumber());
    } catch {
      // No endpoint configured for this chain. Nothing to warm.
    }
  }
}
