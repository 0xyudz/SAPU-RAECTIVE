# SAPU

**Silent Automated Purge Unit** — *sapu* is Indonesian for broom.

> Fund a burner wallet. It empties itself before anyone can watch it fill.

A burner or an ERC-5564 stealth address normally needs native gas to withdraw. Funding that
gas from your main wallet links both addresses on-chain, permanently — which destroys the
entire point of the burner. SAPU removes that link.

You arm a route once. From then on, a Reactive Smart Contract watches your origin chain for
`Transfer` logs addressed to your burner and, the instant tokens land, a forwarder sweeps them
to your cold wallet. **The burner never holds gas. The burner never sends a transaction.**

The origin chain is a configuration choice, not a source edit: any chain in Reactive's official
[origins-and-destinations table](https://dev.reactive.network/origins-and-destinations) works —
9 mainnet and 4 testnet chains. The live demo runs on Base Sepolia + Reactive Lasna, and the
walkthrough below uses those; the same contracts deploy to the others unchanged.

**SAPU does not need its own token.** It sweeps whatever ERC-20 you point it at, so a mainnet
deployment targets an asset that already exists — set `SAPU_TOKEN_ADDRESS` and no token is
deployed. Only two contracts go on chain: `SapuRSC` (on the Reactive chain) and
`SapuForwarder` (on the token's chain). `SweepableERC20` is a demo token for a local run, and
is deployed only when `SAPU_TOKEN_ADDRESS` is left empty.

Built for **Reactive Omni Buildathon — Track 2: "Set It and Forget It"**.

---

## The loop in one picture

```
  you (once)                  Reactive chain                   origin chain
      │                              │                              │
      │  registerRoute(burner,token) │                              │
      ├─────────────────────────────▶│                              │
      │                              │  subscribe(<origin id>,      │
      │                              │    token, Transfer,          │
      │                              │    topic2=burner)            │
      │                              ├─────────────────────────────▶│
      │                              │                              │
                                                    ┌─── someone funds the burner ──┐
      │                              │                              │                │
      │                              │        Tx1  Transfer →burner │◀───────────────┘
      │                              │◀─────────────────────────────┤   (LOG3)
      │  react(): topic0 == Transfer │                              │
      │  topic2 == armed burner?     │                              │
      │  requestCallbackV_1_0(...)   │                              │
      │                              ├── Tx2  CallbackRequest ─────▶│
      │                              │                              │
      │                              │    SapuForwarder.executeSweep│
      │                              │◀─────────────────────────────┤   Tx3
      │                              │     transferFrom(burner →    │
      │                              │          coldWallet)         │
      │                              │                              │
```

Three transactions, two chains. The only human action is the one-time arming step. In the live
demo the origin is Base Sepolia and the Reactive chain is Lasna; nothing in the diagram is
specific to either.

| Leg | Where | What it proves |
| --- | --- | --- |
| **Tx1** | origin chain | tokens reached the burner (`Transfer`) |
| **Tx2** | Reactive chain | the RSC saw it and asked for a callback (`CallbackRequest`) |
| **Tx3** | origin chain | the forwarder moved the tokens to cold storage (`TokensSwept`) |

---

## Architecture

Two contracts, deliberately split across two chains. A single contract cannot be both reactive
and a callback receiver — `AbstractPayer` holds one immutable `_SERVICE_PROVIDER`, so inheriting
both base classes passes the same constructor argument twice. Two chains, two contracts.

```
contracts/
  src/
    reactive/SapuRSC.sol                       # watches the origin chain, requests callbacks
    destination/SapuForwarder.sol              # executes the sweep, authenticates the callback
    token/SweepableERC20.sol                   # demo ERC-20 with EIP-2612 permit
    base/AbstractPausableReactiveContract.sol  # exact-match subscription registry + pause
    interfaces/                                # ISapuForwarder (Reactive interfaces come from lib/reactive)
  test/                                        # 99 Foundry tests, 100% branch coverage
  script/                                      # deploy + arm, env-driven; ReactiveChains.sol holds the
                                               #   official 13-chain callback-proxy table

app/src/
  domain/          # pure: routes, receipts, registry, ledger, budget, proof. No I/O, no React, no viem.
  application/     # use cases against ports: registration-service, route-lifecycle, budget-controls, refusal-lab, sweep-orchestrator
  infrastructure/  # viem clients, contract bindings, event indexers, wallet & ephemeral key vault
  config/          # chain table + per-chain RPC, minimal ABIs, VIEWS registry, docs content
  components/      # shared AppShell, ProofDrawer, PreflightPanel, LiveBadge, landing-live, etc. (no infra/ABI imports)
  app/             # /, /app, /app/arm, /app/ledger, /app/budget, /app/refusals, /docs, /api/*

docs/              # SPEC-REACTIVE-LOOP, INTEGRATIONS, LIMITATIONS, JUDGING
scripts/           # deploy helpers, e2e demo, verification
```

**The dependency rule holds.** `domain/` imports nothing from `application/`,
`infrastructure/`, or `components/`. `SweepOrchestrator` depends on `SweepObservationPort` — an
interface — and `/api/watch` injects the live implementation. That is why the orchestrator can
be tested without a chain, and why the chain client can be replaced without touching policy.

### Two independent authentication checks

`SapuForwarder.executeSweep` requires **both**:

1. `onlyServiceProvider` — `msg.sender` must be the callback proxy. Without it, anyone could
   call the function directly and forge the injected sender address.
2. `onlyCallbackSender(reactiveSender_)` — the address injected into the first payload word must
   be the `SapuRSC` fixed at construction. Without it, any reactive contract on the network
   could drive this forwarder through the legitimate proxy.

The forwarder also keeps its **own** `(token, burner) → coldWallet` registry and rejects any
callback whose destination disagrees with it. A compromised RSC still cannot redirect a sweep
to an attacker. This is defence in depth, not trust.

A test proves it: an attacker deploys a second `SapuRSC`, arms the same burner pointing at
themselves, requests a callback through the **genuine** proxy, and the forwarder rejects it.
The attacker receives nothing.

---

## Quickstart

```bash
git clone <repo> && cd sapu
npm install
bash scripts/setup-contracts.sh   # fetches pinned Solidity deps into contracts/lib
```

### Build and test — no keys, no network

```bash
npm test                     # 99 Foundry + Vitest tests
npm run coverage:contracts   # 100% lines / statements / branches / functions
npm run lint                 # ESLint, flat config (Next.js 16 removed `next lint`)
npm run typecheck            # tsc --noEmit
npm run audit                # scripts/audit-surface.ts (VIEWS, dead exports, layer rules, simulateContract)
npm run build                # runs audit + Next.js production build
npm run dev                  # http://localhost:3000
```

Everything above works with an **empty environment**. Chain-dependent paths degrade to an
explicit "not configured" state rather than a fake number: `/api/watch` returns 503, the proof
table shows *waiting*, and the watcher renders `—` for block heights.

### The live loop

Requires funded keys. See `.env.example`; every variable is documented there.

```bash
cp .env.example .env      # then fill in DEPLOYER_PRIVATE_KEY & REACTIVE_PRIVATE_KEY

# 0. Pick the pair: SAPU_ORIGIN_CHAIN_ID (default 84532) + the Reactive RPC.
#    Both must be on the same network; the deploy script refuses a mismatch.

# 1. Idempotent deploy: SapuRSC on the Reactive chain, SapuForwarder on the origin
#    chain. The callback proxy is looked up from block.chainid, not hardcoded.
#    Writes app/.env.local.
bash scripts/deploy-live.sh

# 2. Verify deployed bytecode (eth_getCode != 0x) & state variables
npx tsx scripts/verify-live.ts

# 3. Deploy/reuse, arm route (with EIP-2612 permit), deposit, wait <= 60s, write docs/proof/latest.json
bash scripts/e2e-demo.sh
```

`scripts/deploy-live.sh` is written for the demo pair (Lasna + Base Sepolia) and reads the RPC
URLs from `BASE_SEPOLIA_RPC_URL` / `REACTIVE_RPC_URL` — the origin endpoint keeps that historical
name regardless of which chain it points at. The deploy *scripts* underneath it are chain-agnostic:
`DeployDestination` looks up the callback proxy for whatever chain its RPC reports, and
`DeployReactiveOmni` reads `SAPU_ORIGIN_CHAIN_ID`. To target another Reactive chain, point those
two RPCs at it and set the chain id.

`scripts/e2e-demo.sh` deploys or reuses contracts, arms a burner route (including an offline EIP-2612 permit), deposits, waits up to 60 seconds for the loop to close, reads all three legs back out of raw chain logs, writes `docs/proof/latest.json`, and prints the **measured** `tx1 → tx3` latency. It never asserts a fixed number, and it never invents a hash: if Tx3 does not happen within 60s it exits non-zero and names the leg that is missing.

Funding:

| Need | Where |
| --- | --- |
| Base Sepolia ETH | any Base Sepolia faucet |
| lREACT | send Base Sepolia ETH to `0x2afaFD298b23b62760711756088F75B7409f5967` (1 ETH → 100 lREACT, max 5 ETH per tx) |

---

## The web app

| Route | Purpose |
| --- | --- |
| `/` | the pitch, five-view links, live `/api/routes` counters, and `docs/proof/latest.json` |
| `/app` | V1 Route Registry — indexed route inventory + `routeOf`/`ruleOf`/`tokensOf`/`subscriptionCount` + owner repairs |
| `/app/arm` | V2 Arm a route — resumable 4-step pipeline (`setForwarder`, `registerRoute`, `armWithPermit` + `armRoute`, `verify`) |
| `/app/ledger` | V3 Sweep Ledger — per-deposit 3-leg join (`complete`, `reactive-only`, `orphan-sweep`) + timestamps & latency |
| `/app/budget` | V4 Callback Budget — sweeps remaining, balances, debts, `setCallbackGasLimit`, `coverDebt` with gas estimates |
| `/app/refusals` | V5 Refusal Lab — 4 live `eth_call` negative paths with raw revert bytes & decoded error names |
| `/docs` | spec index |
| `/docs/[slug]` | `reactive-loop`, `security`, `limitations` |
| `/api/routes` | indexed route inventory + on-chain verification (`eth_getCode != 0x`) |
| `/api/ledger` | 3-leg sweep ledger across Base Sepolia and Reactive Lasna |
| `/api/budget` | live balances, debts, gas price, and sweep capacity |
| `/api/refusals` | live `eth_call` refusal probes |
| `/api/health` | live block heads from both chains |
| `/api/watch` | single-burner loop observation endpoint (503 when unconfigured) |

**The burner key never leaves the browser.** `ephemeral-key-vault.ts` is a module-scoped `Map`
whose every function calls `assertBrowser()`, which throws when `window` is undefined. No
storage API is referenced anywhere in the module, and no server route imports it. The server
component path renders `"Initialising browser key vault…"` until mount, precisely so no key
operation can run during SSR.

The live watcher is not decoration. Its pulse animates only while it is actually watching, and
it renders `—` for block heights when the RPC is unreachable — the honest signal.

---

## Status: what was verified, and what wasn't

Stated plainly, because a claim you cannot check is not evidence.

**Verified in this environment**

| Check | Result |
| --- | --- |
| `forge test` | 99 tests, all passing |
| `forge coverage` | **100%** lines, statements, branches, functions across `src/` |
| `forge build` | exit 0; no lint findings in `src/` |
| `vitest run` | 219 tests across 18 files, all passing |
| `eslint .` | 0 errors, 0 warnings |
| `tsc --noEmit` | clean |
| `npm run audit` | 5/5 views routed, 0 dead exports, 0 layer violations, 13-chain table consistent, 4/4 write use cases call `simulateContract` |
| `next build` | all routes compile: `/`, `/app`, `/app/arm`, `/app/ledger`, `/app/budget`, `/app/refusals`, `/docs`, `/docs/[slug]` (+ 3 SSG doc pages), `/api/{health,watch,routes,ledger,budget,refusals,balance}` |
| `GET /api/health` | live heads: Base Sepolia, Reactive Lasna (both advanced on every run) |
| `/api/watch` unconfigured | `400 {"error":"burner, token and cold must be valid addresses"}` — no fabricated receipt |
| Production `next start` | all six pages `200`; the five `/app` views additionally verified in a real browser (see `e2e:views` below) |
| Lasna system contract | on-chain inspection confirmed the Omni callback selectors |
| `scripts/setup-contracts.sh` | fresh clone reproduces the full suite from pinned deps |
| Live deploy + e2e loop | 4/4 legs `success`; measured Tx1 → Tx3 latency 1 s; see the transaction table below |
| `/api/refusals` | 4/4 real decoded reverts from the live contracts (an unreachable RPC reports `outcome: "error"`, never a fabricated revert) |
| `scripts/verify-proof.ts` | re-fetches every receipt and the `TokensSwept` log; all pass |
| `npm run e2e:views` | all 5 views in a real headless Chrome: no console error, no page exception, no failed request, no `/api/*` non-2xx, and view content present in the DOM |
| Ledger latency (live) | cold build **10.8 s**, warm **~330 ms**, post-cache rebuild **456–614 ms**; measured before the fix: cold 34.6 s, rebuild ~7.4 s |

**Verified live on Base Sepolia + Reactive Lasna.** `scripts/deploy-live.sh`, `scripts/verify-live.ts`, and
`scripts/e2e-demo.sh` were executed against real testnets with funded throwaway keys, and the loop closed in
**1 s** of wall-clock block time. Every hash below is read back from raw chain logs by
`scripts/verify-sweep.ts`; `npx tsx scripts/verify-proof.ts` re-fetches all four receipts and asserts
`status == success` plus the `TokensSwept` payload.

### Verified testnet transactions

Source of truth: [`docs/proof/latest.json`](docs/proof/latest.json), written by `scripts/e2e-demo.sh`. The
landing page at `/` renders that same file, so the table and the UI cannot drift apart.

| Leg | Chain | Transaction | Block | Gas used |
| --- | --- | --- | --- | --- |
| Arm / Register route | Reactive Lasna (5318007) | [`0x2b660e…b452d89d`](https://lasna.reactscan.net/tx/0x2b660ece078440f7c5cf909f526e71b3a26dd441e4662e3538ce1822b452d89d) | 8968543 | 318,184 |
| Tx1 · Deposit into empty burner | Base Sepolia (84532) | [`0xb0cf83…deded7c3`](https://sepolia.basescan.org/tx/0xb0cf8328458ec9949721fdd5f6a5dc722d97f7078d3229a966b623090eded7c3) | 62113984 | 51,591 |
| Tx2 · Reactive callback request | Reactive Lasna (5318007) | [`0xdc0f88…4f689e4b7f`](https://lasna.reactscan.net/tx/0xdc0f8807e7bb78901ff8d67faa82cc1452c68ae0a74f6ad8326fb04f689e4b7f) | 8968575 | 93,602 |
| Tx3 · Forwarder sweep → cold wallet | Base Sepolia (84532) | [`0x310b04…19749b0a`](https://sepolia.basescan.org/tx/0x310b0490044f4c1cb3b3fcf5fd35e51a693d4b8de8a68c897015528719749b0a) | 62113989 | 100,801 |

**Measured Tx1 → Tx3 latency: 1,000 ms (1 block).** The burner held **0 ETH** at deposit time and never
signed a transaction; the cold wallet received the tokens without ever touching a key.

| Deployed contract | Chain | Address |
| --- | --- | --- |
| `SapuRSC` | Reactive Lasna (5318007) | [`0x8fba619b8CC60Af7E0f6e866693B423D8c40c570`](https://lasna.reactscan.net/address/0x8fba619b8CC60Af7E0f6e866693B423D8c40c570) |
| `SapuForwarder` | Base Sepolia (84532) | [`0x5AD6Ee4eCf39f6c433221c3756036d65673d24bC`](https://sepolia.basescan.org/address/0x5AD6Ee4eCf39f6c433221c3756036d65673d24bC) |
| `SweepableERC20` (SAPU, 18 dp) | Base Sepolia (84532) | [`0x3a9476c8bB0076B98aa1116E4344B3111Da645Fb`](https://sepolia.basescan.org/address/0x3a9476c8bB0076B98aa1116E4344B3111Da645Fb) |

Four refusals were also exercised against the live contracts from `/api/refusals`; each returns a real
decoded revert (`OwnableUnauthorizedAccount`, `NotAuthorized`, `RouteNotArmed`, `NothingToSweep`) rather
than a mocked error. A probe whose RPC call never lands (timeout, rate limit) is reported as
`outcome: "error"` with the transport message and **no** decoded name — the endpoint never presents an
unreachable node as contract behaviour.

**Zero mocked chain state.** The test doubles in `contracts/test/mocks/` simulate the system
contract and the callback proxy *because the real ones live on different chains* — they are
never deployed and never imported by `src/` or `script/`. The application talks only to real
RPC endpoints.

### Known limitations

| Gap | Impact |
| --- | --- |
| Dust griefing is bounded, not eliminated | `SapuRSC.minDeposit` (default `1` base unit) makes each forced callback cost the attacker, and `DustIgnored` makes every skip visible — but a funded attacker can still meet the floor |
| One origin pair per deployment | The contracts are chain- and token-agnostic, and the ledger now discovers tokens from the RSC's own route events, so several tokens can be watched in one deployment. The **origin chain** is still one pair per deployment: `NEXT_PUBLIC_SAPU_ORIGIN_CHAIN_ID` names a single origin. Sweeping across two origin chains means a second deployment. |
| No automatic permit acquisition | would require server-side key custody — rejected on principle |
| `RouteRegistered` is public | arms the burner↔cold-wallet association on-chain before any deposit |
| Standing allowance after a sweep | the permit grants a persistent allowance; see `LIMITATIONS.md` §1 |
| Owner is trusted | the owner can arm/revoke routes and change the callback gas limit |
| Live forwarder predates `rescueSweep` | the four stranded burners from the earlier deployment cannot be moved; the ledger reports `unsupported` per row rather than offering a button that would revert |

### How log scanning is bounded and cached

The ledger and the route registry are built from `eth_getLogs`, so their latency is the
latency of those requests. Three properties keep it bounded, each measured against the live
endpoints rather than assumed:

- **The chunk size fits the chain.** One `SPAN` constant used to apply to every chain, and it
  was larger than Lasna's limit, so every scan paid for a bisect to discover a cap that never
  changes. Chunk sizes now live in `app/src/config/log-ranges.ts`: Lasna 29,999 (measured —
  30,000 is rejected), Base Sepolia 100,000 (a chosen value; the real cap is above 5,000,000).
  An unmeasured chain gets a conservative fallback, and if a provider is still tighter the scan
  halves the chunk once and remembers it for the process, so the discovery is paid once.
- **Chunk bounds are absolute, not window-relative.** Chunks are aligned to multiples of the
  chunk size, so as the scanned window slides with the head, only the chunk it enters is new.
  This is what makes a poll cheap: the window is `head - lookback .. head`, and previously the
  head advancing by one block changed every cache key.
- **Only the events wanted are downloaded.** The ledger used to fetch every system-contract
  event and discard almost all of them. Filtering by recipient at the node took one 30k-block
  page from 2,779 ms / 1,045 events to 749 ms / 0 events. The decoded filter is still applied
  afterwards, so a node that ignores the filter cannot inject another deployment's callbacks.

At most two requests per chain are in flight. Two is the measured sweet spot, not a guess:
on Base Sepolia a token scan went 1,386 ms → 811 ms going from one to two concurrent requests,
then *worsened* at four (1,504 ms) and eight (2,915 ms); on Lasna, two gave no gain at all.

**Measured on the live deployment:** cold `/api/ledger` 34.6 s → **10.8 s**, and the rebuild
that happens each time the cache goes stale 7.4 s → **456–614 ms**. Warm reads are ~330 ms.

### Deliberate deviations from the brief

Each is documented with its reasoning in [`docs/SPEC-REACTIVE-LOOP.md`](docs/SPEC-REACTIVE-LOOP.md)
and [`docs/JUDGING.md`](docs/JUDGING.md).

1. **`SYSTEM.requestCallbackV_1_0(...)` instead of `emit Callback(...)`.** The `Callback` event
   is deprecated in the current `reactive-lib-omni`, and the live Lasna system contract
   implements the Omni API. Verified on-chain: implementation `0xbbbb…bbbb` contains selector
   `0x6407b0c1` (`requestCallbackV_1_0`). Following the brief literally would mean shipping
   against a deprecated path.
2. **`executeSweep(address,address,address,address,uint256)`.** The leading `address` is
   mandatory: Reactive Network overwrites the first 160 bits of every payload with the
   requesting contract's address, so the destination must declare an `address` in position 0
   or authentication is impossible. `burner` is also required, because the forwarder must know
   which address to pull from and which rule to check.
3. **`registerRoute` is `onlyOwner`.** Left permissionless it is a direct theft primitive:
   anyone could point a victim's burner at their own cold wallet.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/SPEC-REACTIVE-LOOP.md`](docs/SPEC-REACTIVE-LOOP.md) | topic hashes, subscription criteria, payload layout, gas budgets, proof methodology |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | every external system and exact protocol constant, verified on-chain |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | threat model, failure modes, what was deliberately not built |
| [`docs/JUDGING.md`](docs/JUDGING.md) | requirement → artefact mapping, and the honest gaps |

---

## Stack

| Layer | Choice |
| --- | --- |
| Contracts | Solidity 0.8.29, Foundry, Reactive Omni (`reactive-lib-omni` @ `3ade0dc`), OpenZeppelin 5.4 |
| App | Next.js 16 (App Router), React 19, Tailwind 4, viem 2.57 |
| Tests | Foundry (contracts), Vitest (domain + infrastructure) |

## License

MIT.
