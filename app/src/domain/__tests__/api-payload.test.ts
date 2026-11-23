import { describe, expect, it } from "vitest";
import { visiblePayload, type StampedPayload } from "@/domain/api-payload";

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
