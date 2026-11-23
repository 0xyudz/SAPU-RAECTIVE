import { describe, expect, it } from "vitest";
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
});
