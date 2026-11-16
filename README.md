# SAPU

**Silent Automated Purge Unit** — *sapu* is Indonesian for broom.

> Fund a burner wallet. It empties itself before anyone can watch it fill.

A burner or an ERC-5564 stealth address normally needs native gas to withdraw. Funding that
gas from your main wallet links both addresses on-chain, permanently — which destroys the
entire point of the burner. SAPU removes that link.

You arm a route once. From then on, a Reactive Smart Contract watches Base Sepolia for
`Transfer` logs addressed to your burner and, the instant tokens land, a forwarder sweeps them
to your cold wallet. **The burner never holds gas. The burner never sends a transaction.**

Built for **Reactive Omni Buildathon — Track 2: "Set It and Forget It"**.

---

## The loop in one picture

```
  you (once)                    Reactive Lasna                 Base Sepolia
      │                              │                              │
      │  registerRoute(burner,token) │                              │
      ├─────────────────────────────▶│                              │
      │                              │  subscribe(84532, token,     │
      │                              │    Transfer, topic2=burner)  │
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

Three transactions, two chains. The only human action is the one-time arming step.

| Leg | Where | What it proves |
| --- | --- | --- |
| **Tx1** | Base Sepolia | tokens reached the burner (`Transfer`) |
| **Tx2** | Reactive Lasna | the RSC saw it and asked for a callback (`CallbackRequest`) |
| **Tx3** | Base Sepolia | the forwarder moved the tokens to cold storage (`TokensSwept`) |

---

## Architecture

Two contracts, deliberately split across two chains. A single contract cannot be both reactive
and a callback receiver — `AbstractPayer` holds one immutable `_SERVICE_PROVIDER`, so inheriting
both base classes passes the same constructor argument twice. Two chains, two contracts.

```
contracts/
  src/
    reactive/SapuRSC.sol                       # watches Base Sepolia, requests callbacks
    destination/SapuForwarder.sol              # executes the sweep, authenticates the callback
    token/SweepableERC20.sol                   # demo ERC-20 with EIP-2612 permit
    base/AbstractPausableReactiveContract.sol  # exact-match subscription registry + pause
    interfaces/                                # ISapuForwarder (Reactive interfaces come from lib/reactive)
  test/                                        # 76 Foundry tests, 100% branch coverage
  script/                                      # deploy + arm, env-driven

app/src/
  domain/          # pure: routes, receipts, rules. No I/O, no React, no viem.
  application/     # orchestration against *ports*, not concrete clients
  infrastructure/  # viem clients, ephemeral key vault. All chain access lives here.
  config/          # chain constants, ABIs, docs content
  components/      # burner generator, QR card, live watcher, proof table
  app/             # /, /app, /docs, /docs/[slug], /api/health, /api/watch

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
npm test              # 76 Foundry + 45 Vitest tests
npm run coverage:contracts   # 100% lines / statements / branches / functions
npm run lint          # ESLint, flat config (Next.js 16 removed `next lint`)
npm run typecheck     # tsc --noEmit
npm run build         # Next.js production build
npm run dev           # http://localhost:3000
```

Everything above works with an **empty environment**. Chain-dependent paths degrade to an
explicit "not configured" state rather than a fake number: `/api/watch` returns 503, the proof
table shows *waiting*, and the watcher renders `—` for block heights.

### The live loop

Requires funded testnet keys. See `.env.example`; every variable is documented there.

```bash
cp .env.example .env      # then fill it in

# 1. Reactive Lasna — deploy the watcher (constructor is payable: fund it with lREACT)
forge script contracts/script/DeployReactiveOmni.s.sol:DeployReactiveOmni \
  --root contracts --rpc-url $REACTIVE_RPC_URL --broadcast \
  --private-key $REACTIVE_PRIVATE_KEY --value 0.05ether

# 2. Base Sepolia — deploy the sweep executor and the demo token
export SAPU_RSC_ADDRESS=0x...   # from step 1
forge script contracts/script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
  --root contracts --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY

# 3. Arm the route on both sides (this is the "set it" in "set it and forget it")
forge script contracts/script/RegisterBurner.s.sol:RegisterBurner \
  --root contracts --sig "registerReactive(address,address,address,address)" \
  $SAPU_RSC_ADDRESS $SAPU_FORWARDER_ADDRESS $SAPU_BURNER_ADDRESS $SAPU_TOKEN_ADDRESS \
  --rpc-url $REACTIVE_RPC_URL --broadcast --private-key $REACTIVE_PRIVATE_KEY

forge script contracts/script/RegisterBurner.s.sol:RegisterBurner \
  --root contracts --sig "armForwarder(address,address,address,address)" \
  $SAPU_FORWARDER_ADDRESS $SAPU_BURNER_ADDRESS $SAPU_COLD_WALLET $SAPU_TOKEN_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 4. Fund the forwarder with ETH — it pays callback gas, not the burner
cast send $SAPU_FORWARDER_ADDRESS --value 0.01ether \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY

# 5. Send tokens into an empty burner and watch it empty itself
bash scripts/e2e-demo.sh
```

`scripts/e2e-demo.sh` deposits, waits for the loop to close, reads all three legs back out of
raw chain logs, and prints the **measured** `tx1 → tx3` latency. It never asserts a fixed
number, and it never invents a hash: if Tx3 does not happen it exits non-zero and says which
leg is missing.

Funding:

| Need | Where |
| --- | --- |
| Base Sepolia ETH | any Base Sepolia faucet |
| lREACT | send Base Sepolia ETH to `0x2afaFD298b23b62760711756088F75B7409f5967` (1 ETH → 100 lREACT, max 5 ETH per tx) |

---

## The web app

| Route | Purpose |
| --- | --- |
| `/` | the pitch, and the three-transaction loop |
| `/app` | burner generator, QR deposit card, live watcher, proof table |
| `/docs` | spec index |
| `/docs/[slug]` | `reactive-loop`, `security`, `limitations` |
| `/api/health` | live block heads from both chains |
| `/api/watch` | the loop observation endpoint (503 when unconfigured) |

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
| `forge test` | 76 tests, all passing |
| `forge coverage` | **100%** lines, statements, branches, functions across `src/` |
| `forge build` | exit 0; no lint findings in `src/` |
| `vitest run` | 45 tests, all passing |
| `eslint .` | 0 errors, 0 warnings |
| `tsc --noEmit` | clean |
| `next build` | all routes compile: `/`, `/app`, `/docs`, `/docs/[slug]` (+ 3 SSG doc pages), `/api/health`, `/api/watch` |
| `GET /api/health` | live heads: Base Sepolia `59436805`, Reactive Lasna `8467988` |
| `/api/watch` unconfigured | `503 {"error":"forwarder not configured"}` — no fabricated receipt |
| Production `next start` | all six pages `200`, no console errors |
| Lasna system contract | on-chain inspection confirmed the Omni callback selectors |
| `scripts/setup-contracts.sh` | fresh clone reproduces 76/76 tests from pinned deps |

**Not verified: the live 3-transaction loop.** It needs funded testnet keys (Base Sepolia ETH
and lREACT), which were not available here. Every script needed to run it is committed and
env-driven — `scripts/e2e-demo.sh` performs the full loop and prints measured latency the
moment keys are supplied. This is stated rather than papered over with a recorded fixture.

**Zero mocked chain state.** The test doubles in `contracts/test/mocks/` simulate the system
contract and the callback proxy *because the real ones live on different chains* — they are
never deployed and never imported by `src/` or `script/`. The application talks only to real
RPC endpoints.

### Known limitations

| Gap | Impact |
| --- | --- |
| No on-chain minimum deposit | dust griefing can force the operator to spend gas |
| Permit support not auto-detected | a non-EIP-2612 token makes `armWithPermit` revert with no UI warning |
| No automatic permit acquisition | would require server-side key custody — rejected on principle |
| `RouteRegistered` is public | arms the burner↔cold-wallet association on-chain before any deposit |
| Standing allowance after a sweep | the permit grants a persistent allowance; see `LIMITATIONS.md` §1 |
| Owner is trusted | the owner can arm/revoke routes and change the callback gas limit |

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
