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
  readonly pairs?: {
    readonly disarmed: { readonly burner: Address; readonly coldWallet: Address };
    readonly zeroBalance: { readonly burner: Address; readonly coldWallet: Address };
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

export interface HealthResponse {
  readonly baseBlock: string | null;
  readonly reactiveBlock: string | null;
  readonly token: HealthToken | null;
  readonly forwarder: string | null;
  readonly rsc: string | null;
  readonly configured: boolean;
  readonly error?: string;
}
