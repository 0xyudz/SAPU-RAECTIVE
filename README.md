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
| `/api/watch` | single-burner loop observation endpoint; reports the block window it actually scanned (503 when unconfigured) |

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
| `vitest run` | 228 tests across 18 files, all passing |
| `eslint .` | 0 errors, 0 warnings |
| `tsc --noEmit` | clean |
| `npm run audit` | 5/5 views routed, 0 dead exports, 0 layer violations, 13-chain table consistent, 4/4 write use cases call `simulateContract` |
| `next build` | all routes compile: `/`, `/app`, `/app/arm`, `/app/ledger`, `/app/budget`, `/app/refusals`, `/docs`, `/docs/[slug]` (+ 3 SSG doc pages), `/api/{health,watch,routes,ledger,budget,refusals,balance}` |
| `GET /api/health` | live heads: Base Sepolia, Reactive Lasna (both advanced on every run) |
| `/api/watch` unconfigured | `400 {"error":"burner, token and cold must be valid addresses"}` — no fabricated receipt |
| `/api/watch` default window | scans from the forwarder deploy block and returns `window` + `summary`; an empty `receipts` array is labelled as partial coverage rather than "no sweep" |
| Production `next start` | all six pages `200`; the five `/app` views additionally verified in a real browser (see `e2e:views` below) |
| Lasna system contract | on-chain inspection confirmed the Omni callback selectors |
| `scripts/setup-contracts.sh` | fresh clone reproduces the full suite from pinned deps |
| Live deploy + e2e loop | 4/4 legs `success`; measured Tx1 → Tx3 latency 1 s; see the transaction table below |
| `/api/refusals` | 4/4 real decoded reverts from the live contracts, all simulated against one named token whose burner pairs are drawn from that token's own armed routes (an unreachable RPC reports `outcome: "error"`, never a fabricated revert) |
| `scripts/verify-proof.ts` | re-fetches every receipt and the `TokensSwept` log; all pass |
| `npm run prove:rescue` / `npm run prove:dust` | both drive the app's real use cases against the live stack; #5 strands a deposit and #4 recovers it |
| `npm run e2e:views` | all 5 views in a real headless Chrome: no console error, no page exception, no failed request, no `/api/*` non-2xx, and view content present in the DOM — plus an API assertion that `/api/watch`'s default window covers the deployment (it returns no receipt for a `complete` ledger row otherwise) |
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
| Arm / Register route | Reactive Lasna (5318007) | [`0x8d9921…e1ad14a`](https://lasna.reactscan.net/tx/0x8d99214ab8ff118aa534e4cacc4a1b6660bedce6b18f650d3d4f84015e1ad14a) | 9106287 | 318,196 |
| Tx1 · Deposit into empty burner | Base Sepolia (84532) | [`0x9719e2…b425d389`](https://sepolia.basescan.org/tx/0x9719e22b15dcbac8e48be20a86ae4fdef37fcebd4a17440ca4b6b896b425d389) | 62905349 | 51,591 |
| Tx2 · Reactive callback request | Reactive Lasna (5318007) | [`0x7a21c6…9825ca`](https://lasna.reactscan.net/tx/0x7a21c62b53f5d2d84c91e61d3a3ad430b58de4dc50c36029751dc885569825ca) | 9117741 | 95,763 |
| Tx3 · Forwarder sweep → cold wallet | Base Sepolia (84532) | [`0x5fce36…7985d18`](https://sepolia.basescan.org/tx/0x5fce361813f12f3d3d6b9cfecf14453220f142326463eb5dbbd000bd87985d18) | 62905353 | 104,628 |

**Measured Tx1 → Tx3 latency: 1,000 ms (1 block).** The burner held **0 ETH** at deposit time and never
signed a transaction; the cold wallet received the tokens without ever touching a key.

| Deployed contract | Chain | Address |
| --- | --- | --- |
| `SapuRSC` | Reactive Lasna (5318007) | [`0x8BF210C429A35EFC0f8618DF1F8b883cdbc7Ea5D`](https://lasna.reactscan.net/address/0x8BF210C429A35EFC0f8618DF1F8b883cdbc7Ea5D) |
| `SapuForwarder` | Base Sepolia (84532) | [`0x3eC83c9B41457B7b40E3c5F2dd107A52E48D4027`](https://sepolia.basescan.org/address/0x3eC83c9B41457B7b40E3c5F2dd107A52E48D4027) |
| `SweepableERC20` (SAPU, 18 dp) | Base Sepolia (84532) | [`0x6dEc8e5106F1858aA85fd39363eeEBD4400C78aD`](https://sepolia.basescan.org/address/0x6dEc8e5106F1858aA85fd39363eeEBD4400C78aD) |

Deploy blocks, read from the deployment receipts: `SapuRSC` **9104066**, `SapuForwarder` **62833035**.

#### Multi-token · any ERC-20, not just the demo token (proven live)

The contracts were always token-agnostic — `SapuForwarder` keys rules by `(token, burner)` and
`SapuRSC` subscribes once per pair with the token as the log filter — but three app-layer reads
resolved `NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` instead of the token being armed. That made SAPU look like
a single-demo-token product: typing another address recorded a route whose symbol and decimals
described a *different* asset, granted the allowance on the *configured* token, and signed the permit
over the *configured* token's domain. The fix reads every one of those from the address the operator
typed, and `npm run prove:multi-token` drives the app's real `armRoute` against two third-party tokens:

| Token | Symbol / decimals | Chain | Route registered (RSC) | Allowance granted (origin) | Rule armed (forwarder) |
| --- | --- | --- | --- | --- | --- |
| Circle test USDC [`0x036cbd…3dcf7e`](https://sepolia.basescan.org/address/0x036cbd53842c5426634e7929541ec2318f3dcf7e) | `USDC` / 6 | Base Sepolia | [`0xedd15b…be92c31a`](https://lasna.reactscan.net/tx/0xedd15bd60e65e17e974484b6e14a76a91249d9f5c6686684ec2a0e74be92c31a) blk 9122716 | [`0xea8221…e28e2ce6`](https://sepolia.basescan.org/tx/0xea822193807e248a35e02708c723e29847578469548fa301aedf9899e28e2ce6) blk 62932885 (permit) | [`0xeaa1df…f95fdf`](https://sepolia.basescan.org/tx/0xeaa1df13fab94e34d305b5c414ac7f2d955c74629ec98180f159763fbdf95fdf) blk 62932896 |
| WETH predeploy [`0x4200…0006`](https://sepolia.basescan.org/address/0x4200000000000000000000000000000000000006) | `WETH` / 18 | Base Sepolia | (same run) | [`0x737a74…eaeeced`](https://sepolia.basescan.org/tx/0x737a742115fee14d8ab16508a1b4e3db57ca42d1ff32926539616eb1feaeeced) blk 62933392 (burner `approve`) | [`0x5d57e9…1313630f`](https://sepolia.basescan.org/tx/0x5d57e959e24f738508ed089b032d7a3bb5f6e48a35cd04c72a9e6c091313630f) blk 62933407 |

Both routes read back on-chain with `rule.armed = true`, `rule.coldWallet` matching the cold wallet,
`allowance > 0`, and `SapuRSC.routeOf(token, burner).active = true` — for the token that was typed,
not the configured default. The proof refuses to pass if it ever arms the configured token.

Three interoperability bugs surfaced only by arming real third-party tokens, and each is now fixed and
pinned by tests:

- **`permit` detection searched proxy bytecode.** Circle's USDC is a ZeppelinOS proxy whose runtime
  code is a ~900-byte forwarder with no ERC-20 selectors; `permit`/`nonces` live in the implementation.
  USDC was reported as having *no* permit, pushing operators onto the burner-signed `approve` fallback —
  the one flow that needs native gas in the burner. `permit-support.ts` now follows one level of proxy
  indirection (EIP-1967 and the ZeppelinOS slot), validating the implementation has code before
  searching it.
- **The EIP-2612 `version` was hardcoded to `"1"`.** USDC uses `"2"`, so the signature covered the wrong
  digest and the token reverted with `EIP2612: invalid signature` — a message that names no field.
  `permit-domain.ts` derives the version by matching the token's own `DOMAIN_SEPARATOR()` over candidate
  versions, and refuses rather than defaulting when none match.
- **`erc20Abi` had no `approve`.** The no-permit fallback failed with `Function "approve" not found on
  ABI` before reaching the chain, so tokens without EIP-2612 were unarmable — a requirement SAPU does not
  have, since the forwarder only needs a plain ERC-20 allowance.

Token metadata for the Arm form comes from `GET /api/token?token=0x…`, which reports a discriminated
`status` of `read` | `no-code` | `not-erc20` (all `200`) | `unreachable` (`502`), so a rate-limited node
is never reported as "your token is not an ERC-20". Verified live: USDC → `USDC`/6, WETH → `WETH`/18,
SAPU → `SAPU`/18, the forwarder → `not-erc20`, an EOA → `no-code`.

**Visible in the UI, not only provable by script.** Four things hid this capability from an operator,
and all four are fixed:

- **Arming was impossible from any browser wallet.** The page required one wallet to own *both*
  `SapuRSC` and `SapuForwarder`. They are separate `onlyOwner` contracts and the live stack has a
  different key for each, so that gate could never be satisfied — the Arm button was dead for every
  operator. Authority is now per step: each step names the contract it needs, a wallet that owns one
  of them can sign its half, and the run resumes from the other. An owner that cannot be read is
  treated as *not* permission.
- **The registry listed hex, not assets.** `/app` now shows `USDC · 6 dp`, `WETH · 18 dp`,
  `SAPU · 18 dp`, with `symbol()`/`decimals()` read from each token contract in one batched call.
- **`tokensOf` was invented.** Every row carried a hardcoded empty array, printed as `tokensOf: 0`
  while the chain answered **3**. It is now a real batched read, and a failed read renders as
  `unreadable` rather than `0` — because "I could not ask" is not "there is nothing".
- **Choosing a token meant pasting hex.** The Arm form's token field was a raw address box, so
  arming a second asset required knowing a 42-character contract address by heart. It is now a
  picker whose options are derived from what the registry read off the chain — never a hardcoded
  USDC/WETH table, which would name the wrong addresses on every other chain. Each option shows the
  token's own `symbol() · decimals`. `Other ERC-20` keeps the free-text path, because a token that
  has never been routed is exactly the one that cannot appear in a list built from arming history.

Two silent fallbacks to the configured token were removed at the same time: an unreadable USDC read
was being labelled `SAPU`/18 in `/api/watch`, and the ledger's rescue path used the configured
decimals. Both printed a confident wrong answer where "unreadable" was the truth.

The deposit card was hardened for the same reason. It used to disappear when `symbol()` could not be
read — removing the only way to fund a burner exactly when the node was rate-limiting. It now stays,
labelled by address with a warning, and disables the amount field when `decimals()` is unreadable
instead of substituting a scale: an amount encoded against the wrong `10^n` is a transfer off by a
trillion, which is worse than a QR that asks the sender to choose.

Two more wrong-token bugs were found by reading the app's own output against the chain, and both are
fixed with tests:

- **The Refusal Lab paired a burner with a token it was not armed for.** Armedness is stored under
  `(token, burner)` in the forwarder, but `/api/refusals` filtered rows by `forwarderArmed` and then
  simulated against the *configured* token. A burner armed only for USDC could be simulated against
  SAPU, so `executeSweep` reverted `RouteNotArmed` on a card that promised `NothingToSweep` — the
  wrong reason, presented as evidence. The live burner happened to be armed for all three tokens, so
  the page was right by luck. `domain/refusal-pairs.ts` now chooses the token once (`probeToken`,
  most-armed route, configured token wins ties) and derives both pairs from rows for *that* token,
  keying balances by `(token, burner)`; no armed pair for the token renders as
  `none — no armed route for this token` rather than being papered over.
- **The ledger printed unscaled integers with a ticker.** Three surfaces each fell back to
  `decimals ?? 0`, so a row whose `decimals()` was unreadable rendered `1230000 USDC` for what is
  1.23 USDC — a million times the real amount, with nothing saying it was unscaled. The rule is now
  one function, `formatAmount` in `domain/sweep-receipt.ts`: null decimals prints
  `1230000 base units USDC`, `0` is still treated as a real scale (a 0-decimal token), and a failed
  read stays `—` because zero is a claim about the chain that a failed read cannot support.

#### Use case #4 · `rescueSweep` (proven live)

A deposit can be stranded — a callback dropped, a route disarmed mid-flight, or a deposit below
`minDeposit`. `rescueSweep` moves it, and the proof drives the application's real `rescueResidue`
service rather than a parallel path:

| Step | Chain | Transaction | Block |
| --- | --- | --- | --- |
| Raise dust floor to 2 SAPU (app `applyBudgetAction`) | Reactive Lasna | [`0x05213e…a5fcbb1`](https://lasna.reactscan.net/tx/0x05213e63764aa277fb9614880fbd42a8973e938e2625d09c58b43879ea5fcbb1) | 9117390 |
| Deposit 0.5 SAPU below the floor → `DustIgnored` | Base Sepolia | [`0x0684cf…d1f2440`](https://sepolia.basescan.org/tx/0x0684cfe4327a50a4e119ace4a07af410bfaa1cc8d5897816e3c172a12d1f2440) | 62903487 |
| `DustIgnored` (RSC skips the sweep) | Reactive Lasna | [`0xe4a11e…7a7f73a5`](https://lasna.reactscan.net/tx/0xe4a11e9759922e9213d049f4ed480c201b93bf8c8fa15f1cfdbfb1957a7f73a5) | 9117394 |
| **Rescue the stranded balance (`rescueSweep`)** | Base Sepolia | [`0xd60096…1465ec3f`](https://sepolia.basescan.org/tx/0xd60096d517e5a95481841f2c0d541bfb7d014fc13eaac64fed862a011465ec3f) | 62903689 |
| Restore dust floor to 1 | Reactive Lasna | [`0x6bc74b…37e7e2d`](https://lasna.reactscan.net/tx/0x6bc74b76c1d98c40a90c342071b198d310b18c644df0876dc5197218e37e7e2d) | 9117416 |

The rescue emitted `TokensSwept` with `reactiveSender = 0x0` — the observable difference between a
rescue and a reactive callback — emptied the burner, moved exactly the stranded balance into the cold
wallet, and incremented `sweepCount` 8 → 9. The `DustIgnored` amount was exactly `5e17`, with no
`PurgeTriggered`. Both proofs are re-runnable: `npm run prove:dust` strands the residue and
`npm run prove:rescue` recovers it. `scripts/verify-proof.ts` does **not** cover these two legs — they
are re-derived from their own receipts and logs by the proof scripts themselves, which refuse to run
when there is no real residue to recover.

Four refusals were also exercised against the live contracts from `/api/refusals`; each returns a real
decoded revert (`OwnableUnauthorizedAccount`, `NotAuthorized`, `RouteNotArmed`, `NothingToSweep`) rather
than a mocked error. All four run against a single token named in the response, and both pair-dependent
cases draw their burners from that token's own registry rows — the forwarder's rule is keyed by
`(token, burner)`, so a burner armed for one asset proves nothing about another. A probe whose RPC call
never lands (timeout, rate limit) is reported as `outcome: "error"` with the transport message and
**no** decoded name — the endpoint never presents an unreachable node as contract behaviour.

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
| Live forwarder predates `rescueSweep` | **Not applicable to the current testnet deployment** — this forwarder has `rescueSweep`, so stranded residues are recoverable (see #4 above). The limitation is real for the earlier deployment, whose four stranded burners cannot be moved: their allowance targets the old forwarder and their keys were never persisted, so no new permit can be signed. The ledger reports `unsupported` per row instead of offering a button that would revert |

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

### Why `/api/watch` reports the window it scanned

`/api/watch` answers "what happened to this one burner?" and is the diagnostic counterpart to the
registry-wide `/api/ledger`. It has no UI caller; it is used by operators and by the orchestrator's
own test suite.

Its default origin window used to be `head - 5_000`. That is not a search of the deployment, and
the difference is not academic: the oldest swept burner on the live deployment is ~1.7M blocks
behind the head, so the endpoint answered

```json
{"receipts": []}
```

for a burner the ledger had already classified as `complete`. The body was identical to the one
returned for a burner that was never funded — an empty result reading as a fact about the chain
when it was really a fact about the scan.

Two changes remove the ambiguity:

- **The default starts at `NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK`**, the first block this
  deployment could have emitted anything in. A head-relative lookback remains only as the fallback
  for a deployment that never recorded a deploy block.
- **The response states its own coverage.** `window` carries `originFromBlock`,
  `originHeadBlock`, `originFromSource` (`deploy-block` / `explicit` / `lookback`),
  `reactiveFromBlock`, and `coversFullHistory`; `summary` is one sentence saying whether an empty
  `receipts` array means "nothing exists" or only "nothing in this window". An unreadable head is
  reported as `null`, never substituted with a number the node did not give.

The cost is honest too: a cold call now scans from the deploy block and takes 6.7–14 s. Widen or
narrow it with `&fromBlock=`, which also sets `originFromSource` to `explicit`.

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
