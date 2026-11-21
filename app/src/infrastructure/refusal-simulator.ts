import type { RefusalPort } from "@/application/refusal-lab";
import type { ContractCall, Simulation } from "@/application/ports";
import { simulateCall } from "./write-support";

export function createRefusalSimulator(): RefusalPort {
  return {
    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, null);
    },
  };
}
