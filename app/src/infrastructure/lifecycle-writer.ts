import type { LifecyclePort } from "@/application/route-lifecycle";
import { createConnectedWriter } from "./connected-writer";

/** Writer for the route-repair use case, on the shared connected-wallet transport. */
export function createLifecycleWriter(): LifecyclePort {
  return createConnectedWriter();
}
