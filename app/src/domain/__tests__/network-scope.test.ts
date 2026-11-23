import { describe, expect, it } from "vitest";
import { networkScope } from "@/domain/network-scope";

/**
 * The switch's only job is to not lie. These tests pin the two properties that make it
 * honest: the live selection claims live, and any other selection claims *not deployed*
 * and names the testnet chains the pages are really reading.
 */

const LIVE = {
  configured: "testnet",
  liveOrigin: "Base Sepolia",
  liveReactive: "Reactive Lasna",
} as const;

describe("networkScope", () => {
  it("reports live when the selection matches the configured deployment", () => {
    const scope = networkScope({ ...LIVE, selected: "testnet" });

    expect(scope.state).toBe("live");
    expect(scope.limitations).toEqual([]);
    expect(scope.prerequisites).toEqual([]);
    expect(scope.summary).toContain("Base Sepolia");
    expect(scope.summary).toContain("Reactive Lasna");
  });

  it("never reports mainnet as live while the build reads testnet", () => {
    const scope = networkScope({ ...LIVE, selected: "mainnet" });

    expect(scope.state).toBe("preview");
    expect(scope.label).not.toBe("live");
  });

  it("says the pages are not mainnet data, and names what they are", () => {
    const scope = networkScope({ ...LIVE, selected: "mainnet" });

    expect(scope.summary).toMatch(/nothing below is mainnet data/i);
    expect(scope.summary).toContain("Base Sepolia");
  });

  it("states the concrete mainnet gaps instead of a vague 'coming soon'", () => {
    const scope = networkScope({ ...LIVE, selected: "mainnet" });
    const all = scope.limitations.join(" ");

    // The load-bearing facts a judge or operator would check.
    expect(all).toMatch(/no SAPU contracts are deployed on mainnet/i);
    expect(all).toContain("1597");
    expect(all).toMatch(/REACT/);
    expect(all).toMatch(/rescueSweep/);
    expect(all).toMatch(/EIP-2612/);
  });

  it("lists what would have to happen for mainnet to become live", () => {
    const scope = networkScope({ ...LIVE, selected: "mainnet" });
    const steps = scope.prerequisites.join(" ");

    expect(scope.prerequisites.length).toBeGreaterThan(1);
    expect(steps).toMatch(/Deploy SapuRSC/);
    expect(steps).toMatch(/SAPU_TOKEN_ADDRESS/);
    expect(steps).toMatch(/arm the route again/i);
  });

  it("does not claim a route can be migrated between networks", () => {
    const scope = networkScope({ ...LIVE, selected: "mainnet" });
    const all = [...scope.limitations, ...scope.prerequisites].join(" ");

    // A migrated route is the specific wrong belief this text exists to prevent.
    expect(all).toMatch(/armed again from scratch|arm the route again/i);
    expect(all).not.toMatch(/migrat(e|ed) automatically/i);
  });

  it("is symmetric: a mainnet build explains a testnet selection", () => {
    const scope = networkScope({
      configured: "mainnet",
      selected: "testnet",
      liveOrigin: "Base",
      liveReactive: "Reactive",
    });

    expect(scope.state).toBe("preview");
    expect(scope.summary).toContain("Base");
    expect(scope.prerequisites.join(" ")).toContain("NEXT_PUBLIC_SAPU_NETWORK=testnet");
  });
});
