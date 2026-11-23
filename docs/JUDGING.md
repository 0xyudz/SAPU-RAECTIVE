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

`CHAIN_ID` is a **constructor argument**, not a constant, so the same contract serves every
origin chain Reactive supports. The full table is transcribed in `app/src/config/chains.ts`
(app) and `contracts/script/ReactiveChains.sol` (deploy), and both are pinned by tests
(`app/src/domain/__tests__/chains.test.ts`, `contracts/test/ReactiveChains.t.sol`) so a wrong
callback proxy fails the build rather than the deployment.

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

- `forge test` — 99 tests, all passing
- `forge coverage` — **100%** lines, statements, branches, functions
- `forge build` — exit 0; no lint findings in `src/`
- `next build` — all routes compile (`/`, `/app`, `/app/arm`, `/app/ledger`, `/app/budget`, `/app/refusals`, `/docs`, `/docs/[slug]` + 3 SSG doc pages, `/api/{health,watch,routes,ledger,budget,refusals,balance}`)
- `eslint .` — 0 errors, 0 warnings
- `vitest run` - 177 tests across 16 files, all passing
- `npm run audit` - 5/5 views routed, 0 dead exports (including `components/`), 0 layer violations, 0 undeclared address literals, 13-chain table consistent between app and scripts, 4/4 write use cases call `simulateContract`
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
- `GET /api/refusals` returned four real decoded reverts from the live contracts; a probe whose RPC call never lands is reported as `error` with no decoded name, so a rate-limited node can never be published as a revert
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
| Foundry (contracts) | **100%** lines / statements / branches / functions (99 tests) |
| Vitest (app domain + infra) | 177 tests across 16 files |

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

The burner-signed `approve` fallback (step 3 of arming, for tokens with no EIP-2612 permit) is
not a fifth write use case: it reuses `armRoute`'s pipeline through an optional `sendWith` hook,
so it inherits the same simulate → preflight → confirm → send → receipt sequence. Both signers
funnel through one `submit()` and therefore one `writeContract` site in `arm-writer.ts`, which is
why the gate still reads 4/4 rather than being special-cased.

`Simulation` is a discriminated union — `reverted` (with mandatory decoded error), `unreachable`,
`rejected` — so a transport failure can never be published as "the contract refused this call".

### 15. Every Reactive origin and destination chain

| Where | Evidence |
| --- | --- |
| Chain table (app) | `app/src/config/chains.ts` — 13 chains, roles explicit (`origin`/`destination`/`reactive`) |
| Chain table (deploy) | `contracts/script/ReactiveChains.sol` — same 13, used by both scripts |
| Pinned to the docs | `app/src/domain/__tests__/chains.test.ts` (15 tests), `contracts/test/ReactiveChains.t.sol` (4 tests) |
| Per-chain RPC | `app/src/config/chain-rpc.ts` — one statically-visible `NEXT_PUBLIC_RPC_URL_<id>` each |
| Wallet chain switch | `infrastructure/injected-wallet.ts` builds `wallet_addEthereumChain` from the table |
| Deploy refuses a guess | `ReactiveChains.callbackProxy` reverts `UnsupportedChain(chainId)` |

Two properties are enforced rather than documented:

- **No invented endpoints.** Reactive publishes RPC URLs only for its own chains; every other
  chain resolves to `null` and the caller reports "RPC not configured". A plausible-looking
  default would fail at the first request while claiming to work.
- **No cross-chain borrowing.** `NEXT_PUBLIC_REACTIVE_RPC_URL` is a historical alias that
  resolves to Lasna (5318007) *only*, so it can never answer for Reactive mainnet (1597) — a
  test pins that, because otherwise a mainnet deployment would deploy successfully and then
  report "RPC not configured" in the app. `scripts/deploy-live.sh` writes the per-chain
  `NEXT_PUBLIC_RPC_URL_<id>` key for whichever Reactive chain it deployed to.
- **No invented tickers.** `nativeSymbol` is `null` where the docs do not state one (Robinhood),
  and the UI prints `"native"` rather than guessing.

Mainnet and testnet are never mixed: `readDeploymentConfig()` returns a `configurationError`
instead of falling back to a default pair, and `DeployReactiveOmni` refuses the mismatch at
deploy time.

The header carries a **testnet / mainnet switch** next to the wallet button. It is a
disclosure, not a re-point: this build reads one deployment, so selecting the other network
cannot show that network's data. Picking it opens a panel that says plainly that nothing on
the page is that network's data, lists the concrete mainnet gaps (no contracts deployed, REACT
and native gas are real money, the live forwarder has no `rescueSweep`, the token needs
EIP-2612), and lists what would have to happen for it to become live. The rules live in
`domain/network-scope.ts` and are pinned by seven tests, including one that fails if the
notice ever claims a route can be migrated between networks.

### 16. Anti-mock gates

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
| Live forwarder predates `rescueSweep` | The deployed `SapuForwarder` bytecode has no `rescueSweep` selector, so the four stranded burners (1e18 each) cannot be moved. The ledger reports `unsupported` per row rather than offering a button that would revert. Redeploying alone does not recover them: the new forwarder needs `armRoute` per burner plus a fresh allowance, which requires the burner key. `infrastructure/forwarder-capabilities.ts` detects the selector from deployed bytecode, so the UI is driven by what the chain says rather than by the app's version. |
| No automatic permit acquisition | Would require server-side key custody. Rejected on principle. |
| `RouteRegistered` is public | Arms the burner↔cold-wallet association on-chain before any deposit. Inherent to the design. |
| Live token is mintable demo token | `SweepableERC20.mint()` is permissionless, so stranded balances carry no financial value and can be reprinted. This is a demo-deployment property, not a protocol guarantee. |
| One token and one origin pair per deployment | `NEXT_PUBLIC_SAPU_*` addresses name a single token, and `NEXT_PUBLIC_SAPU_ORIGIN_CHAIN_ID` a single origin. The contracts are chain- and token-agnostic (token is a `(token, burner)` key everywhere), but the app's configuration surface is not yet a list. Sweeping a second token means a second deployment or a config change, not a UI action. |
| Dust griefing is bounded, not eliminated | `SapuRSC.minDeposit` (default `1` base unit) makes each forced callback cost the attacker at least that much and emits `DustIgnored` on every skip, but a funded attacker can still meet the floor. Documented in `LIMITATIONS.md` §6. |

### Hardening that closed earlier gaps

| Was | Now |
| --- | --- |
| `SapuForwarder` had no reentrancy guard | `executeSweep` and `rescueSweep` both carry OZ `nonReentrant`. Two tests deploy a hostile token as **both** callback proxy and callback sender so the re-entrant call clears `onlyServiceProvider` and `onlyCallbackSender`, leaving the guard as the only check able to refuse it; the assertion is on `ReentrancyGuardReentrantCall.selector`. Both were verified to fail with the modifier removed. |
| `SapuRSC.react` requested a callback for any non-zero amount, silently returning on zero | An owner-tunable `minDeposit` bounds the griefing and `DustIgnored(burner, token, amount)` makes every skip a visible chain fact. |
| `setCallbackGasLimit` accepted values Reactive silently drops | The setter rejects anything under `MIN_CALLBACK_GAS_LIMIT` (100 000) with `GasLimitTooLow(requested, minimum)`, instead of leaving the operator with a limit that produces no callback and no error. |
| A token with no EIP-2612 `permit` was a dead end | The arming flow falls back to a burner-signed `approve`, through the same simulate → preflight → send → receipt pipeline, with `gas payer: burner 0x…` shown in the preflight diff. |
| Deploy scripts hardcoded Base Sepolia's proxy and chain id | `contracts/script/ReactiveChains.sol` holds the official 13-chain table; scripts look the proxy up from `block.chainid` and revert `UnsupportedChain` rather than guessing. `ReactiveChains.t.sol` pins every value. |
