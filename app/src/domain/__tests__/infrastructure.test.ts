import { describe, expect, it } from "vitest";
import { buildPaymentUri, toBaseUnits } from "@/components/qr-deposit-card";
import { decodeCallbackPayload, decodeSweepRequest } from "@/infrastructure/reactive-rpc-client";
import { withRpcRetry } from "@/infrastructure/rpc-retry";
import { decodeSweptAmount, decodeTransferAmount } from "@/application/sweep-orchestrator";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";

describe("withRpcRetry", () => {
  it("retries a gateway rate limit instead of publishing it as a failed read", async () => {
    let attempts = 0;
    const value = await withRpcRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Request exceeds defined limit.");
      return "ok";
    });
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry a contract revert", async () => {
    let attempts = 0;
    await expect(
      withRpcRetry(async () => {
        attempts += 1;
        throw new Error('The contract function "executeSweep" reverted');
      }),
    ).rejects.toThrow(/reverted/);
    expect(attempts).toBe(1);
  });
});

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
  // Real bytes captured from the live `CallbackRequest` log at Lasna block 8968575 — the
  // proof callback. The previous fixture here encoded `configuration` as a *flat* four-member
  // tuple, which is not what the chain emits: the real field is `abi.encode` of a struct, so
  // it starts with a `0x20` offset word. The decoder threw on live data, the catch turned that
  // into `"0x"`, and the reactive leg of the proof silently vanished while this test stayed
  // green. A fixture that does not come from the chain cannot prove the decoder works.
  const LIVE_CALLBACK_DATA =
    "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000014a340000000000000000000000005ad6ee4ecf39f6c433221c3756036d65673d24bc0000000000000000000000000000000000000000000000000000000000061a80000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000a46e50f7e200000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a9476c8bb0076b98aa1116e4344b3111da645fb00000000000000000000000020f2a68ecc1335567d54c1f2b0674469d38d335c0000000000000000000000005e45df5c1476db6a9e03b7c9e0863faddac497670000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000" as const;

  it("decodes the struct-wrapped configuration the chain actually emits", () => {
    const payload = decodeCallbackPayload(LIVE_CALLBACK_DATA);

    expect(payload.startsWith("0x6e50f7e2")).toBe(true);
    const decoded = decodeSweepRequest(payload);
    expect(decoded).not.toBeNull();
    expect(decoded?.token).toBe("0x3a9476c8bb0076b98aa1116e4344b3111da645fb");
    expect(decoded?.burner).toBe("0x20f2a68ecc1335567d54c1f2b0674469d38d335c");
    expect(decoded?.coldWallet).toBe("0x5e45df5c1476db6a9e03b7c9e0863faddac49767");
    expect(decoded?.amount).toBe(1_000_000_000_000_000_000n);
  });

  it("still decodes a flat, unwrapped configuration", () => {
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
