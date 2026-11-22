import type { Address } from "@/domain/burner-route";
import type { DecodedCallError } from "@/domain/tx-receipt";
import type { RefusalCaseId, RefusalCaseResult } from "@/domain/refusal";
import type { ContractCall } from "./ports";

export interface RefusalInput {
  readonly rsc: Address;
  readonly forwarder: Address;
  readonly token: Address;
  readonly callbackProxy: Address;
  readonly nonOwner: Address;
  readonly disarmedBurner: Address;
  readonly disarmedColdWallet: Address;
  readonly zeroBalanceBurner: Address;
  readonly zeroBalanceColdWallet: Address;
}

export interface RefusalPort {
  simulateContract(call: ContractCall): Promise<
    | { readonly ok: true; readonly prepared: unknown; readonly gas: bigint | null }
    | { readonly ok: false; readonly reason: string; readonly decoded?: DecodedCallError }
  >;
}

interface CaseSpec {
  readonly id: RefusalCaseId;
  readonly title: string;
  readonly call: ContractCall;
  readonly expectedError: string;
  readonly explanation: string;
}

function stringifyArgs(args: readonly unknown[] | undefined): string[] {
  if (!args) return [];
  return args.map((arg) => {
    if (typeof arg === "bigint") return arg.toString();
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
    return JSON.stringify(arg);
  });
}

async function runCase(port: RefusalPort, spec: CaseSpec): Promise<RefusalCaseResult> {
  const simulation = await port.simulateContract(spec.call);

  if (simulation.ok) {
    return {
      id: spec.id,
      title: spec.title,
      call: formatCall(spec.call),
      executedFrom: spec.call.account ?? "0x0000000000000000000000000000000000000000",
      expectedError: spec.expectedError,
      outcome: "unexpected-success",
      raw: "0x",
      decodedName: null,
      decodedArgs: [],
      explanation: spec.explanation,
      detail: "The node accepted this call. The expected refusal did not happen.",
    };
  }

  const decoded = simulation.decoded;
  return {
    id: spec.id,
    title: spec.title,
    call: formatCall(spec.call),
    executedFrom: spec.call.account ?? "0x0000000000000000000000000000000000000000",
    expectedError: spec.expectedError,
    outcome: decoded ? "reverted" : "error",
    raw: decoded?.raw ?? "0x",
    decodedName: decoded?.name ?? null,
    decodedArgs: stringifyArgs(decoded?.args),
    explanation: spec.explanation,
    detail: decoded ? undefined : simulation.reason,
  };
}

function formatCall(call: ContractCall): string {
  const args = call.args
    .map((arg) => (typeof arg === "bigint" ? arg.toString() : String(arg)))
    .join(", ");
  return `${call.contract}.${call.functionName}(${args})`;
}

export async function runRefusalLab(
  port: RefusalPort,
  input: RefusalInput,
): Promise<readonly RefusalCaseResult[]> {
  const cases: CaseSpec[] = [
    {
      id: "non-owner-register",
      title: "registerRoute from a non-owner",
      call: {
        contract: "rsc",
        functionName: "registerRoute",
        args: [input.disarmedBurner, input.disarmedColdWallet, input.token],
        label: "registerRoute from a non-owner",
        account: input.nonOwner,
      },
      expectedError: "OwnableUnauthorizedAccount",
      explanation:
        "A permissionless registerRoute would let an attacker point someone else's burner at their own cold wallet and harvest every deposit. Ownership is the boundary that makes a burner safe to publish.",
    },
    {
      id: "non-provider-sweep",
      title: "executeSweep from a non-service-provider",
      call: {
        contract: "forwarder",
        functionName: "executeSweep",
        args: [input.rsc, input.token, input.disarmedBurner, input.disarmedColdWallet, 1n],
        label: "executeSweep from a non-provider",
        account: input.nonOwner,
      },
      expectedError: "NotAuthorized",
      explanation:
        "Without the service-provider check, anyone could call executeSweep directly and forge the injected reactive sender. The callback proxy is the only address allowed to drive a sweep.",
    },
    {
      id: "disarmed-route",
      title: "Sweep on a disarmed route",
      call: {
        contract: "forwarder",
        functionName: "executeSweep",
        args: [input.rsc, input.token, input.disarmedBurner, input.disarmedColdWallet, 1n],
        label: "sweep with no armed rule",
        account: input.callbackProxy,
      },
      expectedError: "RouteNotArmed",
      explanation:
        "Even a genuine callback cannot move funds from a pair the operator never armed. This is why arming both sides before the first deposit matters: a route armed on only the RSC side fails here.",
    },
    {
      id: "zero-balance",
      title: "Sweep with zero balance",
      call: {
        contract: "forwarder",
        functionName: "executeSweep",
        args: [input.rsc, input.token, input.zeroBalanceBurner, input.zeroBalanceColdWallet, 1n],
        label: "sweep with nothing to sweep",
        account: input.callbackProxy,
      },
      expectedError: "NothingToSweep",
      explanation:
        "The forwarder refuses to emit a TokensSwept event for a zero-value transfer. A sweep of nothing would corrupt the proof record and still cost gas.",
    },
  ];

  return Promise.all(cases.map((spec) => runCase(port, spec)));
}
