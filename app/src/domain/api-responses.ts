import type { Address } from "./burner-route";
import type { RefusalCaseResult } from "./refusal";

export interface BudgetView {
  readonly callbackGasLimit: string;
  readonly minDeposit: string | null;
  readonly dustFloorSupported: boolean | null;
  readonly rscBalance: string;
  readonly forwarderBalance: string;
  readonly gasPrice: string;
  readonly rscDebt: string;
  readonly forwarderDebt: string;
  readonly sweepsRemaining: string;
  readonly costPerSweepWei: string;
}

export interface BudgetResponse {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly budget?: BudgetView;
  readonly owners?: { readonly rsc: Address | null; readonly forwarder: Address | null };
  readonly checkedAt?: string;
}

export interface RefusalResponse {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly error?: string;
  readonly cases: readonly RefusalCaseResult[];
  readonly callers?: { readonly nonOwner: Address; readonly callbackProxy: Address };
  /** The token every case was simulated against. */
  readonly token?: Address;
  readonly pairs?: {
    readonly disarmed: { readonly burner: Address; readonly coldWallet: Address };
    /**
     * Null when no armed pair exists for the probed token, in which case the `zero-balance`
     * case cannot reach `NothingToSweep` and the response says so instead of implying it did.
     */
    readonly zeroBalance: { readonly burner: Address; readonly coldWallet: Address } | null;
    /** True when the disarmed pair is synthetic because no unarmed pair exists for the token. */
    readonly disarmedIsSynthetic?: boolean;
  };
  readonly checkedAt?: string;
}

export interface BalanceResponse {
  readonly burner: Address;
  readonly token: Address;
  /** Live balance in base units, or null when the read failed. Never a stand-in zero. */
  readonly balance: string | null;
  readonly error?: string;
}

export interface HealthToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Response of `/api/token?token=0x…` — metadata for the token in the Arm form.
 *
 * ## Why `status` is a field and not inferred from HTTP codes
 *
 * The Arm view must tell three different facts apart, and each has a different fix:
 *
 * - `"read"` — the token answered; arm may proceed.
 * - `"not-erc20"` — the chain answered and the address does not describe itself as an ERC-20
 *   (no code there, or `symbol()`/`decimals()` do not answer as ERC-20 values). Fix: type a
 *   different address. Served as `200`, because the request itself succeeded.
 * - `"unreachable"` — the read never completed (429, timeout, bad gateway). Fix: retry. Served
 *   as `502`, because the request did not.
 *
 * Encoding the distinction in the body rather than relying on the status code keeps the client
 * from having to parse a human-readable `reason` string to know which case it is looking at.
 */
export type TokenMetadataResponse =
  | {
      readonly token: Address;
      readonly chainId: number;
      readonly status: "read";
      readonly symbol: string;
      readonly decimals: number;
    }
  | {
      readonly token: Address;
      readonly chainId: number;
      /** `eth_getCode` returned empty: nothing is deployed at this address. */
      readonly status: "no-code";
    }
  | {
      readonly token: Address;
      readonly chainId: number;
      /** A contract exists, but it does not answer `symbol()`/`decimals()` as an ERC-20. */
      readonly status: "not-erc20";
      readonly reason: string;
    }
  | {
      readonly token: Address;
      readonly chainId: number;
      readonly status: "unreachable";
      readonly error: string;
    };

export interface HealthResponse {
  readonly baseBlock: string | null;
  readonly reactiveBlock: string | null;
  readonly token: HealthToken | null;
  readonly forwarder: string | null;
  readonly rsc: string | null;
  readonly configured: boolean;
  readonly error?: string;
}
