import { describe, expect, it } from "vitest";
import {
  addressKey,
  stampRead,
  visiblePayload,
  visibleRead,
  type StampedPayload,
} from "@/domain/api-payload";

const A = "/api/balance?burner=0xaaa";
const B = "/api/balance?burner=0xbbb";

describe("visiblePayload", () => {
  it("shows a payload stamped with the current url", () => {
    const payload: StampedPayload<string> = { url: A, data: "1000", error: null, loading: false };
    expect(visiblePayload(payload, A)).toEqual({ data: "1000", error: null, loading: false });
  });

  it("hides a payload from a different url instead of showing a stale number", () => {
    const payload: StampedPayload<string> = { url: A, data: "1000", error: null, loading: false };
    // This is the regression that mattered: burner A's balance under burner B's address.
    expect(visiblePayload(payload, B)).toEqual({ data: null, error: null, loading: true });
  });

  it("reports loading when nothing has arrived yet", () => {
    expect(visiblePayload<string>(null, A)).toEqual({ data: null, error: null, loading: true });
  });

  it("treats a null url as suspended, not as loading and not as an error", () => {
    expect(visiblePayload<string>(null, null)).toEqual({ data: null, error: null, loading: false });
  });

  it("does not surface a stale error under a new url either", () => {
    const failed: StampedPayload<string> = { url: A, data: null, error: "boom", loading: false };
    expect(visiblePayload(failed, B)).toEqual({ data: null, error: null, loading: true });
  });

  it("passes through an error that belongs to the current url", () => {
    const failed: StampedPayload<string> = { url: A, data: null, error: "boom", loading: false };
    expect(visiblePayload(failed, A)).toEqual({ data: null, error: "boom", loading: false });
  });
});

const BURNER_A = "0xaaaa000000000000000000000000000000000001";
const BURNER_B = "0xbbbb000000000000000000000000000000000002";
const RSC = "0xcccc000000000000000000000000000000000003";
const FWD = "0xdddd000000000000000000000000000000000004";
const TOKEN = "0xeeee000000000000000000000000000000000005";
const COLD = "0xffff000000000000000000000000000000000006";

describe("addressKey", () => {
  it("is null when any input is missing, so no read can be matched to a partial form", () => {
    expect(addressKey([RSC, FWD, null, TOKEN])).toBeNull();
    expect(addressKey([RSC, FWD, "", TOKEN])).toBeNull();
  });

  it("ignores address case, because the same address arrives lowercased and checksummed", () => {
    expect(addressKey([RSC.toUpperCase().replace("0X", "0x")])).toBe(addressKey([RSC]));
  });

  it("distinguishes different burners, which is the whole point", () => {
    expect(addressKey([RSC, FWD, BURNER_A, TOKEN])).not.toBe(addressKey([RSC, FWD, BURNER_B, TOKEN]));
  });
});

describe("visibleRead", () => {
  it("shows a value read for the current inputs", () => {
    const key = addressKey([RSC, FWD, BURNER_A, TOKEN])!;
    expect(visibleRead(stampRead(key, "route active"), key)).toBe("route active");
  });

  it("hides the previous burner's chain state instead of relabelling it", () => {
    // The regression: `snapshot` was plain state, so switching the burner field left burner A's
    // "route.active true / allowance unlimited" panel on screen under burner B's address.
    const aKey = addressKey([RSC, FWD, BURNER_A, TOKEN])!;
    const bKey = addressKey([RSC, FWD, BURNER_B, TOKEN])!;
    expect(visibleRead(stampRead(aKey, "route active"), bKey)).toBeNull();
  });

  it("hides an arm verdict once the destination is edited", () => {
    // `outcomeKey` includes the cold wallet: an "armed" verdict for destination A must not
    // stand as a verdict about destination B.
    const withA = addressKey([FWD, BURNER_A, TOKEN, COLD])!;
    const withB = addressKey([FWD, BURNER_A, TOKEN, "0x9999000000000000000000000000000000000007"])!;
    expect(visibleRead(stampRead(withA, { ok: true }), withB)).toBeNull();
  });

  it("shows nothing when the inputs are incomplete", () => {
    expect(visibleRead(stampRead("k", "v"), null)).toBeNull();
  });

  it("shows nothing before the first read lands", () => {
    expect(visibleRead<string>(null, "k")).toBeNull();
  });
});
