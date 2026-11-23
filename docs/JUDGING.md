# JUDGING

How each requirement maps to a concrete, checkable artefact. Every claim links to a file or a
command you can run.

---

## Track 2 — "Set It and Forget It"

The thesis: a user performs one setup action, and the system acts autonomously forever after.
SAPU's setup action is **arming a route**. After that, no user transaction is ever required —
not to deposit, not to sweep, not to withdraw.

---

## Requirement → artefact

### 1. "Fund a burner wallet. It empties itself before anyone can watch it fill."

| Where | Evidence |
| --- | --- |
| Landing page headline | `app/src/app/page.tsx` |
| Enforced in code | `contracts/src/destination/SapuForwarder.sol` — `executeSweep` |
| Proven in tests | `test_executeSweep_burnerNeverNeedsGas` asserts `burner.balance == 0` before **and** after the sweep |

The claim is not marketing. It is a test assertion.

---

### 2. Reactive Smart Contract subscribes per burner, filters topic_2

| Where | Evidence |
| --- | --- |
| `registerRoute` builds the criteria | `contracts/src/reactive/SapuRSC.sol` |
| Exact six-tuple asserted | `test_registerRoute_subscribesWithExactCriteria` |
| Spec with hashes | `docs/SPEC-REACTIVE-LOOP.md` §3 |

```solidity
SYSTEM.subscribe(
    CHAIN_ID,
    token,
    TRANSFER_TOPIC_0,
    REACTIVE_IGNORE,                      // topic1: any sender
    uint256(uint160(burner)),             // topic2: the burner
    REACTIVE_IGNORE                       // topic3
);
```

The test asserts each of the six arguments individually, including that `topic2` equals
`uint256(uint160(burner))` and that `topic1`/`topic3` are exactly `REACTIVE_IGNORE`.

---

### 3. `react()` verifies topic_2 and emits a callback

| Where | Evidence |
| --- | --- |
| Implementation | `SapuRSC.react` |
| Verification | `log_.opCode != 3` guard, then `_routes[token][burner].active` check |
| Payload assertion | `test_react_emitsCallbackForRegisteredBurner` compares the full payload against `abi.encodeWithSignature(...)` |
| Negative tests | `test_react_ignoresTransferFromBurner`, `test_react_ignoresUnregisteredBurner`, `test_react_ignoresNonLog3Encoding` |

**Deviation, stated openly:** the brief says `emit Callback(...)`. SAPU calls
`SYSTEM.requestCallbackV_1_0(...)` instead, because the `Callback` event is marked deprecated
in the current `reactive-lib-omni` and the live Lasna system contract implements the Omni API.
Verified on-chain: implementation `0xbbbb…bbbb` contains selector `0x6407b0c1`
(`requestCallbackV_1_0`). See `docs/SPEC-REACTIVE-LOOP.md` §5.

The 150,000 gas limit is honoured verbatim (`test_react_emitsCallbackForRegisteredBurner`
asserts `cb.gasLimit == 150_000`).

---

### 4. `SapuForwarder` inherits `AbstractCallback` and sweeps

| Where | Evidence |
| --- | --- |
| Inheritance | `contracts/src/destination/SapuForwarder.sol` |
| Two guards | `onlyServiceProvider` + `onlyCallbackSender(reactiveSender_)` |
| Auth proven | `test_executeSweep_revertsWhenCallerIsNotProxy`, `test_executeSweep_revertsWhenCallbackSenderIsWrong`, `test_executeSweep_rejectsCallbackFromForeignRSC` |
| Sweep proven | `test_executeSweep_movesTokensToColdWallet` asserts balances and the `TokensSwept` event |
| Events | `TokensSwept`, `PermitArmed`, `RouteArmed`, `RouteDisarmed` |

The third test is the strongest: a second, attacker-controlled `SapuRSC` registers the same
burner pointing at the attacker, requests a callback through the **genuine** proxy, and the
forwarder rejects it. The attacker receives nothing.

---

### 5. "No mock: real Base Sepolia logs, real Reactive Omni subscription, verified 3-tx loop"

| Where | Evidence |
| --- | --- |
| Zero mocks in production path | `contracts/script/*` deploys only real contracts |
| Test doubles are isolated | `contracts/test/mocks/*` — never deployed, never imported by `src/` or `script/` |
| Real chain reads in the app | `app/src/infrastructure/*` — live RPC, no fixtures |
| Verification script | `scripts/verify-sweep.ts` queries all three legs |
| Live heads demonstrated | `GET /api/health` returns real block numbers from both chains |

**What was actually executed and verified in this environment:**

- `forge test` — 86 tests, all passing
- `forge coverage` — **100%** lines, statements, branches, functions
- `forge build` — exit 0; no lint findings in `src/`
- `next build` — all routes compile (`/`, `/app`, `/app/arm`, `/app/ledger`, `/app/budget`, `/app/refusals`, `/docs`, `/docs/[slug]` + 3 SSG doc pages, `/api/{health,watch,routes,ledger,budget,refusals,balance}`)
- `eslint .` — 0 errors, 0 warnings
- `vitest run` — 139 tests across 14 files, all passing
- `npm run audit` — 5/5 views routed, 0 dead exports (including `components/`), 0 layer violations, 0 undeclared address literals, 4/4 write use cases call `simulateContract`
- `npm run typecheck` — clean (`tsc --noEmit`)
- `GET /api/health` returned live heads for Base Sepolia and Reactive Lasna
- `/api/watch` with no parameters returned `400`, not a fabricated receipt
- All six pages served `200` from a production `next start`, with no console errors and no mojibake
- `scripts/setup-contracts.sh` reproduced the full suite from a clean clone with pinned deps
- On-chain inspection of the Lasna system contract confirmed the Omni callback selectors
- `readPermitSupport` returned `true` for the live token, and the token's source is
  `ERC20Permit` — the detector is not guessing

**Live testnet run (executed, not simulated):**

- `bash scripts/deploy-live.sh` deployed `SapuRSC` on Reactive Lasna (5318007), then `SapuForwarder`
  and `SweepableERC20` on Base Sepolia (84532), and wrote the addresses into `app/.env.local`
- `npx tsx scripts/verify-live.ts` confirmed bytecode, ownership, the wired callback sender, and token metadata
- `bash scripts/e2e-demo.sh` armed a route (including an offline EIP-2612 permit), deposited into a
  zero-ETH burner, and closed the loop: **4/4 legs `success`, measured Tx1 → Tx3 latency 1,000 ms (1 block)**
- `npx tsx scripts/verify-proof.ts` re-fetched all four receipts plus the `TokensSwept` log — all pass
- `GET /api/refusals` returned four real decoded reverts from the live contracts
  (`OwnableUnauthorizedAccount`, `NotAuthorized`, `RouteNotArmed`, `NothingToSweep`)

The hashes are in [`docs/proof/latest.json`](../docs/proof/latest.json) and the README table; they were read
back from raw chain logs, never typed in by hand.

---

### 6. "Burner generator, ephemeral keys in browser only, never persisted server-side"

| Where | Evidence |
| --- | --- |
| Vault | `app/src/infrastructure/ephemeral-key-vault.ts` |
| UI | `app/src/components/burner-generator.tsx` |
| Browser-only enforced | Every vault function calls `assertBrowser()`, which throws when `window` is undefined |
| Never persisted | No storage API is referenced anywhere in the module |

The vault is a module-scoped `Map`. There is no server route that imports it. The server
component path renders `"Initialising browser key vault…"` until mount, precisely so no key
operation can occur during SSR.

---

### 7. QR deposit card

| Where | Evidence |
| --- | --- |
| Component | `app/src/components/qr-deposit-card.tsx`, rendered on `/app/arm` once a burner and token metadata are known |
| EIP-681 URI | `buildPaymentUri` — unit-tested |
| Exact decimal conversion | `toBaseUnits` — tested against excess-precision and non-numeric input |
| Rendered client-side | QR generated with `qrcode`, lime-on-void, never uploaded |

The card only appears when the burner address and the token's `symbol`/`decimals` have both
been read from the chain. Rendering it with guessed metadata would produce a QR that pays the
wrong token.

---

### 8. Live status, read from the chain or not shown at all

| Where | Evidence |
| --- | --- |
| Component | `app/src/components/landing-live.tsx` (`LandingLive`) and `app/src/components/live-badge.tsx` (`LiveBadge`) |
| Counter source | `/api/routes` — every number is a live `eth_getLogs`/`eth_call` result |
| Honest failure | `liveValue()` returns `—` when `configured` or `verified` is false; the badge drops to `DEGRADED`/`NO DATA` |
| Chain heads | `AppShell` renders both heads from `/api/health`; an unreachable RPC renders `—`, never a stale number |

There is no polling log tail any more. It was removed in the same commit that removed the
unused sweep cap: it re-rendered a terminal nobody could trigger from the UI, and its
"watching" state was a client-side animation rather than a chain fact. The counters above it
are the replacement, and they are falsifiable.

The badge is not decorative. `probeState()` returns `live` only when the API answered *and*
`verified` is true; otherwise the surface says so.

---

### 9. Verified receipts: Tx1 → Tx2 → Tx3

| Where | Evidence |
| --- | --- |
| Component | `ProofDrawer` in `app/src/components/proof-drawer.tsx` |
| Data model | `app/src/domain/sweep-receipt.ts` (`withReactiveLeg`, `withSweepLeg`, `IncompleteReceiptError`) |
| No fabricated legs | `SweepReceipt.sweep` and `sweptAmount` are `null` until Tx3 is observed |
| Explorer links | Every receipt carries `explorerUrl` built from the chain that produced it |
| Live artefact | `docs/proof/latest.json`, read by `infrastructure/proof-file.ts` |

A receipt cannot claim a sweep it did not observe. `sweptAmount` stays `null` until Tx3 is
seen, and `IncompleteReceiptError` is thrown rather than returning a half-filled receipt, so
no caller can accidentally render an invented hash.

---

### 10. `scripts/e2e-demo.sh` prints the sweep completing

| Where | Evidence |
| --- | --- |
| Script | `scripts/e2e-demo.sh` |
| Composed of | `scripts/trigger-deposit.ts` + `scripts/verify-sweep.ts` |
| Latency | Measured from real block timestamps, printed as `tx1 → tx3` |

Reports the measured number rather than asserting a fixed one, because live block times vary.

---

### 11. Clean Architecture

| Layer | Location | Rule |
| --- | --- | --- |
| Domain | `app/src/domain/` | Pure. No I/O, no React, no viem. Unit-tested. |
| Application | `app/src/application/` | Orchestration against **ports** (interfaces), not concrete clients |
| Infrastructure | `app/src/infrastructure/` | Implements the ports. All viem usage lives here. |
| Config | `app/src/config/` | Chain constants, ABIs, docs content |
| Components | `app/src/components/` | Presentation only |
| Routes | `app/src/app/` | `/, /app, /docs, /docs/[slug]` + API routes |

The dependency rule holds: domain imports nothing from application, infrastructure, or
components. `SweepOrchestrator` depends on `SweepObservationPort` (an interface), and
`/api/watch` injects the live implementation. That is what lets the orchestrator be tested
without a chain and the chain clients be swapped without touching policy.

---

### 12. Test coverage > 95%

| Suite | Result |
| --- | --- |
| Foundry (contracts) | **100%** lines / statements / branches / functions (86 tests) |
| Vitest (app domain + infra) | 139 tests across 14 files |

```
forge coverage --no-match-coverage "test/*|script/*" --report summary
```

---

### 13. Five-view operator surface

| View | Route | Use case / source |
| --- | --- | --- |
| V1 Route Registry | `/app` | `route-indexer.ts`, `route-lifecycle.ts` (`applyRouteRepair`) |
| V2 Arm | `/app/arm` | `registration-service.ts` (`armRoute`, resumable 4-step pipeline) |
| V3 Sweep Ledger | `/app/ledger` | `ledger-indexer.ts` (`complete`, `reactive-only`, `orphan-sweep`) |
| V4 Callback Budget | `/app/budget` | `budget-reader.ts`, `budget-controls.ts` |
| V5 Refusal Lab | `/app/refusals` | `refusal-lab.ts`, `refusal-simulator.ts` |

`config/views.ts` is the single registry: the landing page, the app shell, and
`scripts/audit-surface.ts` all read `VIEWS`. A view without a matching route file fails the
audit.

### 14. Transaction protocol

Every write path is `simulateContract` → `PreflightDiff` → operator approval → send → receipt.
The state machine is `idle → simulating → signing → pending → confirmed | failed`; a receipt
carries `hash`, `chainId`, `explorerUrl`, `blockNumber`, `gasUsed`, `status`, and `label`
(`domain/tx-receipt.ts`). Reverts are decoded from raw bytes in `infrastructure/revert.ts`.
There are exactly four write use cases — arm a route, repair a route, cover callback debt, and
rescue a stranded balance — and `scripts/audit-surface.ts` proves each one calls
`simulateContract` and that `app/src` has exactly four `writeContract` sites.

### 15. Anti-mock gates

```bash
grep -rniE "placeholder|fixture|dummy|seeded|sample data" app/src   # empty
grep -rn "setArmed" app/src                                         # empty
npm run audit
```

The audit also rejects a component importing `infrastructure/` or `config/abis`, rejects any
exported symbol with no external import site (tests do not count as import sites, and
`components/` is scanned too), and rejects a contract address literal outside `config/`.

---

## Deliberate deviations from the brief

Stated openly, with reasoning. All three are documented in `docs/SPEC-REACTIVE-LOOP.md`.

### 1. `requestCallbackV_1_0` instead of `emit Callback`

The `Callback` event is deprecated in `reactive-lib-omni` and the live system contract
implements the Omni API. Following the brief literally would mean shipping against a
deprecated path. Verified on-chain that the Omni selector exists.

### 2. `SapuForwarder.executeSweep` takes `(address,address,address,address,uint256)`

The brief shows `(token, coldWallet, amount)`. The leading `address` is **mandatory**:
Reactive Network overwrites the first 160 bits of every payload with the requesting contract's
address, and the destination must declare an `address` in position 0 or authentication is
impossible. `burner` is also required, because the forwarder needs to know which address to
pull from and which rule to check.

### 3. `registerRoute` is `onlyOwner`

Not specified either way. Left permissionless, it is a direct theft primitive: anyone could
point a victim's burner at their own cold wallet. Owner-gating is the correct default for a
personal privacy tool.

---

## Honest gaps

| Gap | Impact |
| --- | --- |
| Live forwarder predates `rescueSweep` | The deployed `SapuForwarder` bytecode has no `rescueSweep` selector, so the four stranded burners (1e18 each) cannot be moved. The ledger reports `unsupported` per row rather than offering a button that would revert. Redeploying alone does not recover them: the new forwarder needs `armRoute` per burner plus a fresh allowance, which requires the burner key. |
| No on-chain minimum deposit | Neither `SapuRSC` nor `SapuForwarder` enforces a floor, and the app-side `RouteRules.minDeposit` field that pretended to was removed because nothing read it. Dust griefing can force the operator to spend gas. Documented in `LIMITATIONS.md` §6. |
| No automatic permit acquisition | Would require server-side key custody. Rejected on principle. |
| `RouteRegistered` is public | Arms the burner↔cold-wallet association on-chain before any deposit. Inherent to the design. |
| Live token is mintable demo token | `SweepableERC20.mint()` is permissionless, so stranded balances carry no financial value and can be reprinted. This is a demo-deployment property, not a protocol guarantee. |
| No reentrancy guard in `SapuForwarder` | `executeSweep` writes no state after `safeTransferFrom` and the destination is the owner-set cold wallet, so the practical risk is low, but there is no `ReentrancyGuard` to make that structural. A hostile token could re-enter. |
