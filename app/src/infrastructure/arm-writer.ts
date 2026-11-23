import { createWalletClient, http, parseSignature, type WalletClient } from "viem";
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
import { contractTarget, ConfigurationError } from "./contracts";
import { currentAccount, ensureChain, getWalletClient } from "./injected-wallet";
import { readPermitSupport } from "./permit-support";
import { rpcOverride } from "@/config/chain-rpc";
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

  /**
   * The one place SAPU submits a transaction.
   *
   * Both the connected-wallet path and the burner-signed fallback funnel through here, so
   * there is exactly one `writeContract` call site in this module. That keeps the audit
   * gate's "one simulateContract per writeContract" invariant true structurally, and means
   * the receipt handling can never drift between the two signers.
   */
  async function submit(
    client: WalletClient,
    request: unknown,
    call: ContractCall,
    onPending?: (hash: `0x${string}`) => void,
  ): Promise<TxReceipt> {
    const target = contractTarget(call.contract);
    const hash = await client.writeContract({
      ...(request as object),
      ...feeOverrides(target.chainId),
      account: client.account!,
      chain: null,
    } as never);

    onPending?.(hash);
    const receipt = await target.client.waitForTransactionReceipt({ hash });
    return resolveMinedReceipt(target, call, hash, receipt);
  }

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
      await ensureChain(contractTarget(call.contract).chainId);
      return submit(client, request, call, onPending);
    },

    /**
     * Burner-signed fallback for tokens with no EIP-2612 permit.
     *
     * `approve` writes `allowance[msg.sender][spender]`, so it must be sent by the burner.
     * That is the one flow where the burner pays gas — the tradeoff the arming step spells
     * out — and it is why this is gated on a key actually being present.
     */
    approveAsBurner: {
      async canSignAsBurner(burner: Address): Promise<boolean> {
        if (burnerKey === null) return false;
        return privateKeyToAccount(burnerKey).address.toLowerCase() === burner.toLowerCase();
      },

      async sendAsBurner(
        prepared: unknown,
        onPending?: (hash: `0x${string}`) => void,
      ): Promise<TxReceipt> {
        if (burnerKey === null) {
          throw new ConfigurationError("No burner key is loaded, so the burner cannot sign an approve.");
        }
        const { call, request } = asPrepared(prepared);
        const account = privateKeyToAccount(burnerKey);
        const target = contractTarget(call.contract);

        // A burner-signed write needs the burner to hold native gas. Checking first turns an
        // opaque "insufficient funds" node error into a sentence the operator can act on.
        const balance = await target.client.getBalance({ address: account.address });
        if (balance === 0n) {
          throw new ConfigurationError(
            `The burner ${account.address} holds no native gas on chain ${target.chainId}, so it cannot send an approve. ` +
              "Fund the burner first, or use a token that implements EIP-2612.",
          );
        }

        const url = rpcOverride(target.chainId);
        if (url === null) {
          throw new ConfigurationError(
            `No RPC endpoint configured for chain ${target.chainId}; cannot send the burner approve.`,
          );
        }

        const client = createWalletClient({ account, transport: http(url) });
        return submit(client, request, call, onPending);
      },
    },

    async permitSupport(token: Address): Promise<boolean | null> {
      return readPermitSupport(token);
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
          chainId: request.chainId,
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
