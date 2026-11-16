import { describe, expect, it } from "vitest";
import { buildPaymentUri, toBaseUnits } from "@/components/qr-deposit-card";
import { decodeCallbackPayload } from "@/infrastructure/reactive-rpc-client";
import { decodeSweptAmount, decodeTransferAmount } from "@/application/sweep-orchestrator";
import { disarmReason, shouldDisarm, ZERO } from "@/domain/route-rules";
import { DEFAULT_ROUTE_RULES } from "@/domain/burner-route";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";

describe("buildPaymentUri", () => {
  it("builds a valid EIP-681 ERC-20 transfer URI", () => {
    const uri = buildPaymentUri({
      token: "0x3333333333333333333333333333333333333333",
      chainId: 84532,
      to: "0x1111111111111111111111111111111111111111",
    });
    expect(uri).toBe(
      "ethereum:0x3333333333333333333333333333333333333333@84532/transfer?address=0x1111111111111111111111111111111111111111",
    );
  });

  it("appends a uint256 amount when supplied", () => {
    const uri = buildPaymentUri({
      token: "0x3333333333333333333333333333333333333333",
      chainId: 84532,
      to: "0x1111111111111111111111111111111111111111",
      amountBaseUnits: "1000000000000000000",
    });
    expect(uri).toContain("&uint256=1000000000000000000");
  });
});

describe("toBaseUnits", () => {
  it("converts whole tokens exactly", () => {
    expect(toBaseUnits("1", 18)).toBe("1000000000000000000");
    expect(toBaseUnits("0.5", 18)).toBe("500000000000000000");
    expect(toBaseUnits("1.23", 6)).toBe("1230000");
  });

  it("rejects excess precision rather than silently rounding", () => {
    expect(toBaseUnits("1.1234567", 6)).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(toBaseUnits("", 18)).toBeNull();
    expect(toBaseUnits("abc", 18)).toBeNull();
    expect(toBaseUnits("-1", 18)).toBeNull();
    expect(toBaseUnits("1e18", 18)).toBeNull();
  });
});

describe("decodeTransferAmount", () => {
  it("decodes the single non-indexed uint256", () => {
    const data = encodeAbiParameters([{ type: "uint256" }], [123456789n]);
    expect(decodeTransferAmount(data)).toBe("123456789");
  });

  it("returns 0 for truncated data", () => {
    expect(decodeTransferAmount("0x")).toBe("0");
  });
});

describe("decodeSweptAmount", () => {
  it("decodes the amount as the first non-indexed word", () => {
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [42n, "0x1111111111111111111111111111111111111111"],
    );
    expect(decodeSweptAmount(data)).toBe("42");
  });
});

describe("decodeCallbackPayload", () => {
  it("unwraps version + configuration to reach the inner payload", () => {
    const innerPayload = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [
        "0x0000000000000000000000000000000000000000",
        "0x3333333333333333333333333333333333333333",
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        1000n,
      ],
    );

    const configuration = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "bytes" }],
      [84532n, "0x4444444444444444444444444444444444444444", 150000n, innerPayload],
    );

    const tail = encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [0, configuration]);

    expect(decodeCallbackPayload(tail)).toBe(innerPayload);
  });

  it("degrades to 0x rather than throwing on an unexpected tail shape", () => {
    expect(decodeCallbackPayload("0xdeadbeef")).toBe("0x");
  });
});

describe("topic constants match their event signatures", () => {
  it("Transfer topic0 matches the hand-written constant", () => {
    const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const topics = encodeEventTopics({ abi: [event] });
    expect(topics[0]).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });
});

describe("route rules", () => {
  it("never disarms a continuous route", () => {
    expect(shouldDisarm(DEFAULT_ROUTE_RULES, 999)).toBe(false);
    expect(disarmReason(DEFAULT_ROUTE_RULES, 999)).toBeNull();
  });

  it("disarms a one-shot route after its cap", () => {
    const rules = { ...DEFAULT_ROUTE_RULES, sweepContinuously: false, maxSweeps: 2 };
    expect(shouldDisarm(rules, 1)).toBe(false);
    expect(shouldDisarm(rules, 2)).toBe(true);
    expect(disarmReason(rules, 2)).toContain("2-sweep cap");
  });

  it("explains a single-sweep route", () => {
    const rules = { ...DEFAULT_ROUTE_RULES, sweepContinuously: false, maxSweeps: null };
    expect(disarmReason(rules, 1)).toContain("single sweep");
  });

  it("exposes ZERO as a base-unit string", () => {
    expect(ZERO).toBe("0");
  });
});
