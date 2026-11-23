import type { BudgetPort } from "@/application/budget-controls";
import { createConnectedWriter } from "./connected-writer";

/**
 * Writer for the callback-budget use case.
 *
 * Bound to `BudgetPort` so the application layer never reaches into viem or the wallet, while
 * the transport itself is the shared connected-wallet writer.
 */
export function createBudgetWriter(): BudgetPort {
  return createConnectedWriter();
}
