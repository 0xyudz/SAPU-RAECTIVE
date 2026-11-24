import { describe, expect, it, vi } from "vitest";
import {
  CHAINS,
  chainById,
  chainLabel,
  isFullyConfigured,
  originChains,
  reactiveChain,
  readDeploymentConfig,
  SYSTEM_CONTRACT,
} from "@/config/chains";
import { rpcOverride } from "@/config/chain-rpc";

/**
 * The chain table is transcribed from
 * https://dev.reactive.network/origins-and-destinations.
 *
 * These tests exist because a wrong callback proxy is invisible until a real callback is
 * delivered and `onlyServiceProvider` rejects it — by which point the deployment is live
 * and the failure looks like a contract bug. Pinning the table to the published values
 * turns a silent misconfiguration into a red test.
 *
 * The expected list below is the official table, written independently of the
 * implementation so that editing `config/chains.ts` alone cannot make this pass.
 */
const OFFICIAL_MAINNET: ReadonlyArray<readonly [number, string]> = [
  [42161, "0xaee8d2debab5be353bfec167c58a549923892e11"],
  [43114, "0x8bdfc7e564b90b31c49cf1079d4c44400f4e14b4"],
  [8453, "0xcc780dde33f56f55de778d42c930959374a4a068"],
  [56, "0xfc41ee9d3a836b41399becce83b06b3e5650f3bb"],
  [1, "0xfce1f192f489c988392abc16e91e359d540d94fe"],
  [999, "0x754120ec7a6ef81e4c5c835aa603c63da64693e6"],
  [1597, "0x8888888888888888888888888888888888888888"],
  [4663, "0x476f44b11f5c942c58f4c8e3d0300e5710743585"],
  [130, "0x754120ec7a6ef81e4c5c835aa603c63da64693e6"],
];

const OFFICIAL_TESTNET: ReadonlyArray<readonly [number, string]> = [
  [84532, "0x476f44b11f5c942c58f4c8e3d0300e5710743585"],
  [11155111, "0xaa14d9cd0f788ca23d11805986c1d8bd035d23b4"],
  [5318007, "0x8888888888888888888888888888888888888888"],
  [1301, "0x775c9b990ade401060b78d0e98684eef8d2466c1"],
];

describe("Reactive chain table", () => {
  it("carries every official mainnet chain with its published callback proxy", () => {
    for (const [id, proxy] of OFFICIAL_MAINNET) {
      const chain = chainById(id);
      expect(chain, `mainnet chain ${id} is missing from the table`).not.toBeNull();
      expect(chain!.callbackProxy, `callback proxy for chain ${id}`).toBe(proxy);
      expect(chain!.network).toBe("mainnet");
    }
  });

  it("carries every official testnet chain with its published callback proxy", () => {
    for (const [id, proxy] of OFFICIAL_TESTNET) {
      const chain = chainById(id);
      expect(chain, `testnet chain ${id} is missing from the table`).not.toBeNull();
      expect(chain!.callbackProxy, `callback proxy for chain ${id}`).toBe(proxy);
      expect(chain!.network).toBe("testnet");
    }
  });

  it("contains no chain beyond the official list", () => {
    const official = new Set([...OFFICIAL_MAINNET, ...OFFICIAL_TESTNET].map(([id]) => id));
    for (const chain of CHAINS) {
      expect(official.has(chain.id), `chain ${chain.id} (${chain.name}) is not in the official table`).toBe(true);
    }
    expect(CHAINS).toHaveLength(official.size);
  });

  it("uses the system contract as the callback proxy on both Reactive chains", () => {
    expect(chainById(1597)!.callbackProxy).toBe(SYSTEM_CONTRACT);
    expect(chainById(5318007)!.callbackProxy).toBe(SYSTEM_CONTRACT);
    expect(chainById(1597)!.reactive).toBe(true);
    expect(chainById(5318007)!.reactive).toBe(true);
  });

  it("lists every non-Reactive chain as both origin and destination", () => {
    for (const chain of CHAINS) {
      if (chain.reactive) continue;
      expect(chain.origin, `${chain.name} should be an origin`).toBe(true);
      expect(chain.destination, `${chain.name} should be a destination`).toBe(true);
    }
  });

  it("does not invent a native ticker for chains the docs leave unstated", () => {
    // The official table links Robinhood's explorer but never names its gas token.
    expect(chainById(4663)!.nativeSymbol).toBeNull();
  });

  it("builds explorer transaction URLs from each chain's own explorer", () => {
    for (const chain of CHAINS) {
      expect(chain.txPath("0xabc")).toBe(`${chain.explorerUrl}/tx/0xabc`);
    }
  });

  it("resolves labels and unknown chain ids honestly", () => {
    expect(chainLabel(8453)).toBe("Base");
    // An id outside the table must not be given a made-up name.
    expect(chainLabel(999999)).toBe("chain 999999");
    expect(chainById(999999)).toBeNull();
  });

  it("separates mainnet and testnet origins", () => {
    const mainnet = originChains("mainnet").map((chain) => chain.id);
    const testnet = originChains("testnet").map((chain) => chain.id);
    expect(mainnet).toContain(8453);
    expect(mainnet).not.toContain(84532);
    expect(testnet).toContain(84532);
    expect(testnet).not.toContain(8453);
    expect(reactiveChain("mainnet").id).toBe(1597);
    expect(reactiveChain("testnet").id).toBe(5318007);
  });
});

describe("deployment configuration", () => {
  it("defaults to the Base Sepolia / Lasna testnet pair", () => {
    const config = readDeploymentConfig();
    expect(config.network).toBe("testnet");
    expect(config.origin.id).toBe(84532);
    expect(config.reactive.id).toBe(5318007);
    expect(config.callbackProxy).toBe("0x476f44b11f5c942c58f4c8e3d0300e5710743585");
    expect(config.configurationError).toBeNull();
  });

  it("is not 'fully configured' while the contract addresses are unset", () => {
    // The test environment has no addresses; the UI must report that rather than pretend.
    const config = readDeploymentConfig();
    expect(isFullyConfigured(config)).toBe(config.rscAddress !== null && config.forwarderAddress !== null);
  });

  it("does not require the default token, because SAPU is token-agnostic", () => {
    // Requiring NEXT_PUBLIC_SAPU_TOKEN_ADDRESS made a multi-token deployment look unconfigured:
    // the token is only the Arm form's default, and every indexer discovers its tokens from
    // `RouteRegistered` events. This pins the rule so a future edit cannot re-add the token.
    const config = readDeploymentConfig();
    expect(config.tokenAddress).toBeNull();
    expect(isFullyConfigured({ ...config, rscAddress: "0x1" as never, forwarderAddress: "0x2" as never })).toBe(
      true,
    );
  });
});

describe("per-chain RPC resolution", () => {
  /**
   * `NEXT_PUBLIC_REACTIVE_RPC_URL` is a historical alias that resolves to Lasna (5318007)
   * only. Writing it for a Reactive-mainnet deployment leaves chain 1597 with no endpoint,
   * and the app then reports "RPC not configured" for a deployment that succeeded — a
   * failure that only shows up on mainnet. These tests pin the resolution rules so the
   * per-chain key is the one that carries a non-default chain.
   *
   * `config/chain-rpc.ts` deliberately reads the environment once, at module load, because
   * Next.js only inlines `process.env.NEXT_PUBLIC_*` when the access is statically visible.
   * Each case therefore stubs first and then imports the module fresh, which is the only way
   * to observe what a real build would see.
   */
  const loadWith = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const loaded = await import("@/config/chain-rpc");
    vi.unstubAllEnvs();
    return loaded.rpcOverride;
  };

  it("reads the historical aliases for the two demo chains", async () => {
    const rpc = await loadWith({
      NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://origin.example",
      NEXT_PUBLIC_REACTIVE_RPC_URL: "https://reactive.example",
    });
    expect(rpc(84532)).toBe("https://origin.example");
    expect(rpc(5318007)).toBe("https://reactive.example");
  });

  it("reads the per-chain key for any chain without a historical alias", async () => {
    const rpc = await loadWith({
      NEXT_PUBLIC_RPC_URL_1597: "https://reactive-mainnet.example",
      NEXT_PUBLIC_RPC_URL_8453: "https://base.example",
    });
    expect(rpc(1597)).toBe("https://reactive-mainnet.example");
    expect(rpc(8453)).toBe("https://base.example");
  });

  it("never lets the Lasna alias answer for Reactive mainnet", async () => {
    const rpc = await loadWith({ NEXT_PUBLIC_REACTIVE_RPC_URL: "https://lasna.example" });
    // 1597 must stay unconfigured: borrowing Lasna's endpoint would send mainnet writes
    // to a testnet node.
    expect(rpc(1597)).toBeNull();
  });

  it("reports 'not configured' rather than borrowing another chain's endpoint", async () => {
    const rpc = await loadWith({});
    expect(rpc(42161)).toBeNull();
    expect(rpcOverride(42161)).toBeNull();
  });
});
