import { describe, expect, it } from "vitest";
import { assessChecks, type CodeCheck } from "@/infrastructure/contracts";
import { scanTokens } from "@/infrastructure/ledger-indexer";
import type { Address } from "@/domain/burner-route";

/**
 * Which configured addresses may decide that SAPU is unusable.
 *
 * ## The bug this pins
 *
 * `verifyDeployment` used to require all three addresses — SapuRSC, SapuForwarder **and** the
 * token — to hold code, and every view gated on that single `verified` flag. But SAPU's
 * contracts are token-agnostic: `SapuForwarder` keys its rules by `(token, burner)`, `SapuRSC`
 * subscribes with the token as the log filter, and both indexers discover their tokens from
 * `RouteRegistered` events. `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` is only the Arm form's default.
 *
 * So a deployment that armed USDC and WETH went dark because the demo token was unset or
 * mistyped: the registry, the ledger, the budget and the refusal lab all refused to read a
 * chain that was perfectly healthy. That is the opposite of multi-token support.
 */

const RSC = "0x8bf210c429a35efc0f8618df1f8b883cdbc7ea5d" as Address;
const FORWARDER = "0x3ec83c9b41457b7b40e3c5f2dd107a52e48d4027" as Address;
const TOKEN = "0x6dec8e5106f1858aa85fd39363eeebd4400c78ad" as Address;

function check(over: Partial<CodeCheck> & Pick<CodeCheck, "name" | "required">): CodeCheck {
  return {
    chainId: 84532,
    address: RSC,
    hasCode: true,
    ...over,
  };
}

const rsc = (hasCode: boolean | null, address: Address | null = RSC): CodeCheck =>
  check({ name: "SapuRSC", required: true, address, hasCode });

const forwarder = (hasCode: boolean | null, address: Address | null = FORWARDER): CodeCheck =>
  check({ name: "SapuForwarder", required: true, address, hasCode });

const token = (hasCode: boolean | null, address: Address | null = TOKEN): CodeCheck =>
  check({
    name: "SweepableERC20",
    required: false,
    address,
    hasCode,
    // `null` means the check never answered, which has no revert reason to report. A `false`
    // means the node answered and said there is no code there.
    error:
      hasCode === true
        ? undefined
        : hasCode === null
          ? "Request exceeds defined limit."
          : "eth_getCode returned 0x — no contract at this address",
  });

describe("assessChecks", () => {
  it("verifies a deployment whose two contracts have code, token or no token", () => {
    expect(assessChecks([rsc(true), forwarder(true), token(null)]).verified).toBe(true);
    expect(assessChecks([rsc(true), forwarder(true), token(null)]).configured).toBe(true);
  });

  it("stays verified when the default token has no code, and says so as a warning", () => {
    // The regression: this used to be `verified: false`, which darkened every view.
    const verdict = assessChecks([rsc(true), forwarder(true), token(false)]);

    expect(verdict.verified).toBe(true);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain(TOKEN);
    expect(verdict.warnings[0]).toContain("any ERC-20");
  });

  it("stays verified when the default token address is not configured at all", () => {
    const verdict = assessChecks([rsc(true), forwarder(true), token(null, null)]);

    expect(verdict.verified).toBe(true);
    // Nothing was set, so there is nothing to warn about: this is the normal multi-token setup.
    expect(verdict.warnings).toEqual([]);
  });

  it("is not verified when a required contract has no code", () => {
    const verdict = assessChecks([rsc(true), forwarder(false), token(true)]);

    expect(verdict.verified).toBe(false);
    expect(verdict.configured).toBe(true);
  });

  it("is not configured when a required address is missing, whatever the token says", () => {
    const verdict = assessChecks([rsc(true), forwarder(true, null), token(true)]);

    expect(verdict.configured).toBe(false);
    expect(verdict.verified).toBe(false);
  });

  it("does not treat an unreadable required check as a pass", () => {
    // A failed `eth_getCode` is `null`, not `true`. Publishing it as verified would let writes
    // target an address nobody confirmed.
    const verdict = assessChecks([rsc(null), forwarder(true), token(true)]);

    expect(verdict.verified).toBe(false);
  });

  it("warns about an unreadable default token without claiming it has no code", () => {
    const verdict = assessChecks([rsc(true), forwarder(true), token(null)]);

    expect(verdict.verified).toBe(true);
    // The warning must repeat what the node said (a rate limit), not assert the absence of a
    // contract — that would be a chain fact nobody observed.
    expect(verdict.warnings[0]).toContain("Request exceeds defined limit.");
    expect(verdict.warnings[0]).not.toContain("no contract at this address");
  });
});

describe("scanTokens", () => {
  const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address;

  it("never scans a configured token that has no code there", () => {
    // The regression: a mistyped NEXT_PUBLIC_SAPU_TOKEN_ADDRESS was added to the `getLogs`
    // filter set unconditionally. Public gateways reject a filter on an address with no code
    // with "Invalid parameters were provided to the RPC method", which marked the whole origin
    // leg uncovered — one typo in an optional setting blanked every deposit and sweep.
    const tokens = scanTokens([USDC], TOKEN, [rsc(true), forwarder(true), token(false)]);

    expect(tokens).toEqual([USDC]);
  });

  it("adds the configured token when the code check confirmed a contract", () => {
    const tokens = scanTokens([USDC], TOKEN, [rsc(true), forwarder(true), token(true)]);

    expect(tokens).toContain(USDC);
    expect(tokens).toContain(TOKEN);
  });

  it("does not add an unreadable configured token, because it cannot be filtered on", () => {
    const tokens = scanTokens([USDC], TOKEN, [rsc(true), forwarder(true), token(null)]);

    expect(tokens).toEqual([USDC]);
  });

  it("keeps every token the registry discovered, whatever the configured default says", () => {
    const tokens = scanTokens([USDC, TOKEN], null, [rsc(true), forwarder(true), token(null, null)]);

    expect(tokens).toContain(USDC);
    expect(tokens).toContain(TOKEN);
  });

  it("deduplicates case-insensitively", () => {
    const tokens = scanTokens([USDC], USDC.toUpperCase().replace("0X", "0x") as Address, [
      rsc(true),
      forwarder(true),
      token(true, USDC),
    ]);

    expect(tokens).toHaveLength(1);
  });
});
