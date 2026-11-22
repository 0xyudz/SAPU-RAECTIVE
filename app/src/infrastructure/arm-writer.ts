import { parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "@/domain/burner-route";
import type {
  ArmingSnapshot,
  ArmInspectInput,
  PermitRequest,
  PermitSignature,
  RouteRegistrationPort,
} from "@/application/registration-service";
import type { ContractCall, Simulation } from "@/application/ports";
import type { TxReceipt } from "@/domain/tx-receipt";
import { BASE_SEPOLIA } from "@/config/chains";
import { contractTarget, ConfigurationError } from "./contracts";
import { currentAccount, ensureChain, getWalletClient } from "./injected-wallet";
import { simulateCall, resolveMinedReceipt, feeOverrides, type PreparedSimulation } from "./write-support";

export interface ArmWriterOptions {
  readonly burnerPrivateKey?: `0x${string}` | null;
}

function lower(value: string): Address {
  return value.toLowerCase() as Address;
}

function asPrepared(value: unknown): PreparedSimulation {
  if (typeof value !== "object" || value === null || !("call" in value)) {
    throw new Error("Invalid prepared simulation.");
  }
  return value as PreparedSimulation;
}

export function createArmWriter(options: ArmWriterOptions = {}): RouteRegistrationPort {
  const burnerKey = options.burnerPrivateKey ?? null;

  return {
    async inspect(input: ArmInspectInput): Promise<ArmingSnapshot> {
      const rsc = contractTarget("rsc");
      const forwarder = contractTarget("forwarder");
      const token = contractTarget("token");

      const [route, rule, activeForwarder, allowance] = await Promise.all([
        rsc.client.readContract({
          address: rsc.address,
          abi: rsc.abi,
          functionName: "routeOf",
          args: [input.token, input.burner],
        }) as Promise<{ coldWallet: Address; active: boolean; registeredBlock: bigint }>,
        forwarder.client.readContract({
          address: forwarder.address,
          abi: forwarder.abi,
          functionName: "ruleOf",
          args: [input.token, input.burner],
        }) as Promise<{ coldWallet: Address; armed: boolean }>,
        rsc.client.readContract({
          address: rsc.address,
          abi: rsc.abi,
          functionName: "sapuForwarder",
        }) as Promise<Address>,
        token.client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: "allowance",
          args: [input.burner, input.forwarder],
        }) as Promise<bigint>,
      ]);

      return {
        forwarder: activeForwarder === "0x0000000000000000000000000000000000000000" ? null : lower(activeForwarder),
        routeActive: route.active,
        routeColdWallet: route.active ? lower(route.coldWallet) : null,
        ruleArmed: rule.armed,
        ruleColdWallet: rule.armed ? lower(rule.coldWallet) : null,
        allowance,
      };
    },

    async simulateContract(call: ContractCall): Promise<Simulation> {
      return simulateCall(call, currentAccount());
    },

    async send(
      prepared: unknown,
      onPending?: (hash: `0x${string}`) => void,
    ): Promise<TxReceipt> {
      const { call, request } = asPrepared(prepared);
      const client = getWalletClient();
      if (!client) {
        throw new ConfigurationError("Connect a wallet to sign this transaction.");
      }
      const target = contractTarget(call.contract);
      await ensureChain(target.chainId);

      const hash = await client.writeContract({
        ...(request as object),
        ...feeOverrides(target.chainId),
        account: client.account!,
        chain: null,
      } as never);

      onPending?.(hash);
      const receipt = await target.client.waitForTransactionReceipt({ hash });
      return resolveMinedReceipt(target, call, hash, receipt);
    },

    async signPermit(request: PermitRequest): Promise<PermitSignature | null> {
      if (burnerKey === null) return null;

      const account = privateKeyToAccount(burnerKey);
      if (account.address.toLowerCase() !== request.burner.toLowerCase()) {
        throw new Error(
          `The selected burner key (${account.address}) does not match the burner address (${request.burner}).`,
        );
      }

      const token = contractTarget("token");
      const [name, nonce] = await Promise.all([
        token.client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: "name",
        }) as Promise<string>,
        token.client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: "nonces",
          args: [request.burner],
        }) as Promise<bigint>,
      ]);

      const signature = await account.signTypedData({
        domain: {
          name,
          version: "1",
          chainId: BASE_SEPOLIA.id,
          verifyingContract: request.token,
        },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: request.burner,
          spender: request.forwarder,
          value: request.value,
          nonce,
          deadline: request.deadline,
        },
      });

      const parsed = parseSignature(signature);
      if (parsed.v === undefined) {
        throw new Error("The burner signature did not contain a v value.");
      }
      return { v: Number(parsed.v), r: parsed.r, s: parsed.s };
    },
  };
}
