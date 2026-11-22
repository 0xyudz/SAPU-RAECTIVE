import { createPublicClient, http, type PublicClient } from "viem";
import { BASE_SEPOLIA, REACTIVE_LASNA } from "@/config/chains";

const TRANSPORT = {
  timeout: 30_000,
  retryCount: 0,
} as const;

let baseClient: PublicClient | null = null;
let reactiveClient: PublicClient | null = null;

export function getBaseClient(): PublicClient {
  baseClient ??= createPublicClient({
    transport: http(BASE_SEPOLIA.rpcUrl, TRANSPORT),
  });
  return baseClient;
}

export function getReactiveClient(): PublicClient {
  reactiveClient ??= createPublicClient({
    transport: http(REACTIVE_LASNA.rpcUrl, TRANSPORT),
  });
  return reactiveClient;
}
