import type { RescuePort } from "@/application/rescue-service";
import { createConnectedWriter } from "./connected-writer";

/**
 * Writer for the rescue use case.
 *
 * Same protocol as every other writer — simulate, then send, then wait for the receipt — but
 * bound to `RescuePort` so the application layer never reaches into viem or the wallet.
 */
export function createRescueWriter(): RescuePort {
  return createConnectedWriter();
}
