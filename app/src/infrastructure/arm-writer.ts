import { createWalletClient, http, parseSignature } from "viem";
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
import { readPermitDomain } from "./permit-domain";
import { withRpcRetry } from "./rpc-retry";
import { rpcOverride } from "@/config/chain-rpc";
import { lower, isZeroAddress } from "./address";
import { simulateCall, asPreparedSimulation, submitPrepared } from "./write-support";

export interface ArmWriterOptions {
  readonly burnerPrivateKey?: `0x${string}` | null;
}

export function createArmWriter(options: ArmWriterOptions = {}): RouteRegistrationPort {
  const burnerKey = options.burnerPrivateKey ?? null;

  return {
    async inspect(input: ArmInspectInput): Promise<ArmingSnapshot> {
      const rsc = contractTarget("rsc");
      const forwarder = contractTarget("forwarder");
      // `contractTarget("token")` names the *configured* token; its ABI and client are the right
      // ones for any ERC-20 on the same chain, but the address must be the one being inspected.
      // Reading `allowance` from the configured token made the snapshot describe a different
      // asset than the route being armed, so a USDC route was armed with SAPU's allowance.
      const token = contractTarget("token");

      // Every read is retried on transport failure. `armRoute` calls `inspect` again *after* the
      // writes to verify the result, so an unretried 429 here turns a fully armed route into a
      // reported failure: both transactions are mined, the route is live, and the operator is
      // told it did not work. The public gateways rate-limit a burst of four `eth_call`s, which
      // is exactly what this parallel batch looks like.
      const [route, rule, activeForwarder, allowance] = await Promise.all([
        withRpcRetry(() =>
          rsc.client.readContract({
            address: rsc.address,
            abi: rsc.abi,
            functionName: "routeOf",
            args: [input.token, input.burner],
          }),
        ) as Promise<{ coldWallet: Address; active: boolean; registeredBlock: bigint }>,
        withRpcRetry(() =>
          forwarder.client.readContract({
            address: forwarder.address,
            abi: forwarder.abi,
            functionName: "ruleOf",
            args: [input.token, input.burner],
          }),
        ) as Promise<{ coldWallet: Address; armed: boolean }>,
        withRpcRetry(() =>
          rsc.client.readContract({
            address: rsc.address,
            abi: rsc.abi,
            functionName: "sapuForwarder",
          }),
        ) as Promise<Address>,
        withRpcRetry(() =>
          token.client.readContract({
            address: input.token,
            abi: token.abi,
            functionName: "allowance",
            args: [input.burner, input.forwarder],
          }),
        ) as Promise<bigint>,
      ]);

      return {
        forwarder: isZeroAddress(activeForwarder) ? null : lower(activeForwarder),
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
      const { call, request } = asPreparedSimulation(prepared);
      const client = getWalletClient();
      if (!client) {
        throw new ConfigurationError("Connect a wallet to sign this transaction.");
      }
      await ensureChain(contractTarget(call.contract).chainId);
      return submitPrepared(client, request, call, onPending);
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
        const { call, request } = asPreparedSimulation(prepared);
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
        return submitPrepared(client, request, call, onPending);
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

      // The EIP-2612 domain is `(name, version, chainId, token)`, and every field must match
      // what the token hashed. `name` comes from the token being permitted, and `version` is
      // *derived* from its `DOMAIN_SEPARATOR()` rather than assumed: Circle's USDC uses "2"
      // while most tokens use "1", and the wrong version produces a valid-looking signature
      // that the token rejects with `EIP2612: invalid signature`.
      const token = contractTarget("token");
      const [domain, nonce] = await Promise.all([
        readPermitDomain(token.client, request.token, request.chainId),
        withRpcRetry(() =>
          token.client.readContract({
            address: request.token,
            abi: token.abi,
            functionName: "nonces",
            args: [request.burner],
          }),
        ) as Promise<bigint>,
      ]);

      if (domain === null) {
        throw new Error(
          `This token's EIP-2612 domain could not be determined: it does not expose a ` +
            `DOMAIN_SEPARATOR() matching any known permit version. Arming with a permit would ` +
            `produce a signature the token rejects, so the allowance must be granted another way.`,
        );
      }

      const signature = await account.signTypedData({
        domain: {
          name: domain.name,
          version: domain.version,
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
