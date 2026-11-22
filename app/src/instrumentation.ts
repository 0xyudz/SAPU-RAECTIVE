import { getBaseClient, getReactiveClient } from "@/infrastructure/rpc-clients";

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const warm = (label: string, run: () => Promise<unknown>) => {
    void run().catch(() => {
      void label;
    });
  };

  warm("base", () => getBaseClient().getBlockNumber());
  warm("reactive", () => getReactiveClient().getBlockNumber());
}
