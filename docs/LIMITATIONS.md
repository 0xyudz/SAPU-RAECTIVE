Nothing in the live application or contract surface is mocked; only Foundry unit tests (`contracts/test/mocks/`) simulate cross-chain system/proxy contracts locally and `RegistrationService`/application unit tests use in-memory fake ports.

# LIMITATIONS

What SAPU does not do, where it can break, and which tradeoffs were chosen deliberately.
Written to be read by a skeptic.

---

## 1. Permit vs allowance

`SapuForwarder.executeSweep` calls `transferFrom(burner, coldWallet, amount)`. That needs an
allowance from the burner. There are exactly two ways to grant one, and they are not
interchangeable.

### EIP-2612 permit — the default

The burner signs a permit message off-chain. Signing is free and produces no transaction.
Any relayer submits it; the **signature** authorizes the allowance, not the caller.

| | |
| --- | --- |
| Burner sends a transaction | No |
| Burner needs native gas | **No** |
| Preserves SAPU's core promise | **Yes** |

This is the only path that satisfies "fund a burner wallet, it empties itself". A burner that
needed gas would need to be funded, and funding it from the main wallet is the exact link SAPU
exists to destroy.

### `approve()` — the fallback

| | |
| --- | --- |
| Burner sends a transaction | Yes |
| Burner needs native gas | **Yes** |
| Preserves SAPU's core promise | **No** |

The burner must be funded with ETH from somewhere. If that somewhere is the main wallet, the
link forms on-chain permanently and the burner's purpose is defeated. This path is only
defensible when the burner already holds gas for unrelated reasons.

### Which tokens support permit

Not all ERC-20s implement EIP-2612. `SweepableERC20` does. Many major tokens do. Some
prominent ones do not, and a few implement a non-standard variant.

**SAPU now checks this before signing.** `infrastructure/permit-support.ts` reads the token's
deployed bytecode for the `permit` and `nonces` selectors (both are required — `permit` without
`nonces` cannot produce a replay-safe signature), following one level of proxy indirection.

That proxy hop is not optional. Circle's USDC on Base Sepolia is a ZeppelinOS proxy whose runtime
code is a ~900-byte forwarder containing no ERC-20 selectors at all; `permit`/`nonces` live in the
implementation it delegates to. Searching only the proxy reported "no permit" for a token that fully
implements it, which pushed operators onto the burner-signed `approve` fallback — the one flow that
needs native gas in the burner, and one that cannot run at all when the burner is unfunded. Both the
EIP-1967 slot and the ZeppelinOS slot are checked, and an implementation is only searched after
`eth_getCode` confirms there is code at it.

When the selectors are absent, arming does not dead-end. It falls back to a plain `approve` signed by
the burner, which is the only remaining way to grant the allowance — but it costs the burner native
gas, so it is attempted only when a burner key is actually loaded and matches the burner address.
If no key is available, arming stops before sending anything and names the reason, rather than
producing a route whose every sweep would revert.

The fallback's cost is stated where the operator approves it: the preflight diff lists
`gas payer: burner 0x…`, and the arm page explains the tradeoff next to the controls. It is the
one flow in SAPU where the burner pays, so it is never silent.

**The EIP-2612 `version` is read, not assumed.** The domain separator commits to
`(name, version, chainId, token)`, and the spec never fixes `version` — most tokens use `"1"`, but
Circle's USDC uses `"2"`. Signing with the wrong one produces a well-formed signature over the wrong
digest, and the token rejects it with `EIP2612: invalid signature`, naming no field. `permit-domain.ts`
derives the version by computing the separator for candidate versions and matching the token's own
`DOMAIN_SEPARATOR()`, and reports the domain as undeterminable rather than defaulting when none match.

Three limits on that check are worth stating:

- It reads the bytecode, so it answers "does the dispatcher route these selectors", not "is the
  implementation correct". A token with a broken or non-standard `permit` will pass the check
  and still fail at simulation time. The simulation is the real gate; this check only makes the
  common case legible.
- If the bytecode cannot be read, the result is `null` and SAPU attempts the permit anyway.
  "Unknown" is never treated as "unsupported", because refusing on an unreadable RPC would
  block tokens that work fine.
- Only one level of proxy indirection is followed. A proxy delegating to another proxy would be
  searched one level short, which can produce a false "no permit" (never a false "has permit", since
  the selectors must actually appear in code that was read).

### Residual risk: the standing allowance

A permit grants a standing allowance to `SapuForwarder`. That allowance is only spendable by
the forwarder, and the forwarder only spends when:

1. `msg.sender` is the callback proxy,
2. the injected sender is the authorized `SapuRSC`,
3. its own armed rule matches the `(token, burner)` pair, and
4. the callback's `coldWallet` equals the armed rule.

So a standing allowance is not a standing risk of theft — but it is a standing approval, and
users should understand that it exists.

---

## 2. Privacy claims — what SAPU does and does not hide

Privacy is not anonymity. Overclaiming here would be dishonest, so the boundaries are explicit.

### What SAPU removes

The **gas-funding link**. Normally, withdrawing from a burner requires native gas, and sending
that gas from your main wallet links both addresses permanently on-chain. SAPU eliminates that
transaction entirely: the burner holds zero ETH for its whole life and never signs anything
except an off-chain permit.

### What SAPU does not remove

| Observable | Why |
| --- | --- |
| **The deposit itself** | The inbound `Transfer` is a public log. Anyone watching the burner sees funds arrive. SAPU shrinks the window; it does not hide the event. |
| **The sweep link** | The outbound `Transfer` links burner → cold wallet on-chain. If the cold wallet is your main wallet, the sweep creates the very link you were avoiding. **Use a genuinely separate cold wallet.** |
| **Timing correlation** | A deposit and a sweep seconds apart are visibly related. |
| **Amount correlation** | The swept amount equals the sum of the deposits that arrived since the previous sweep (unless clamped), so the transfers are pairable: the ledger reconstructs which deposits a sweep cleared from that sum. |
| **The burner's existence** | The address is registered on `SapuRSC` in a public `RouteRegistered` event, which names the burner, the cold wallet, and the token. |

That last point deserves emphasis: **arming a route publicly associates the burner with the
cold wallet before a single deposit arrives.** `RouteRegistered` has all three addresses
indexed. This is inherent to the design — the RSC must know the destination — but it means
SAPU is not a tool for hiding who owns a burner. It is a tool for not needing to fund one.

### Threat model summary

| Adversary | Protected? |
| --- | --- |
| Someone reading the chain | No — everything above is public |
| Someone who compromised the SAPU server | Yes for keys (none are there); no for route metadata |
| Someone with XSS in this app | **No** — see §5 |
| Someone front-running the sweep | Partially — the destination is re-checked on-chain |

---

## 3. Latency

The loop is fast but not instant.

| Segment | Typical |
| --- | --- |
| Base Sepolia inclusion | ~2s per block |
| Reactive Lasna detection | ~1s blocks, CometBFT instant finality, no reorgs |
| Base Sepolia callback inclusion | ~2s per block |
| **End to end** | **a few seconds** |

The claim to hold SAPU to is "before anyone can watch it fill" — meaning the burner is not a
durable resting place for value — **not** "zero latency". Funds are exposed for the duration of
the loop. `scripts/e2e-demo.sh` reports the measured latency rather than asserting a fixed
budget, because the honest number depends on live block times.

---

## 4. Failure modes

Every one of these is reachable in production. None is hypothetical.

### Route armed on only one side

The RSC subscription and the forwarder rule are two separate transactions on two chains.
If only the RSC side is armed, the callback fires and reverts with `RouteNotArmed`; the
deposit sits in the burner. A **later** deposit re-triggers the loop for *itself*, but it
does not sweep the stranded balance - see "A failed sweep strands the deposit" below. The
stuck deposit is not automatically retried and needs an explicit `rescueSweep`.

If only the forwarder side is armed, no subscription exists and nothing is ever triggered.

`RegistrationService` verifies both sides agree before reporting success, precisely because
a partial arm is silently useless.

### No allowance

`executeSweep` reverts inside `safeTransferFrom`. The proxy charges the forwarder for the
attempt and emits `CallbackFailure`. The deposit stays put.

### Forwarder in debt

The callback proxy reverts with `InDebt` **before** attempting delivery, so callbacks stop
entirely. `coverDebt()` is permissionless — anyone can fix it — but nothing does so
automatically.

### RSC in debt

It receives no reactive transactions at all. Silently stops watching. `coverDebt()` is
permissionless here too.

### Callback gas too low

Two distinct shapes:

- Too low for proxy overhead → `InsufficientGas`, method never runs.
- Covers overhead but not the method → method reverts → `CallbackFailure`.

Both are configured on the **reactive** side, so the fix is raising `callbackGasLimit` on
`SapuRSC`, not adding ETH to the forwarder.

There is also a silent third shape, which is why the setter is now guarded. Reactive **drops any
callback request whose gas limit is below 100 000** with no revert and no event — the transaction
succeeds, nothing is delivered, and there is no on-chain trace to explain it. `setCallbackGasLimit`
therefore rejects anything under `MIN_CALLBACK_GAS_LIMIT` with `GasLimitTooLow(requested, minimum)`,
turning a mystery into a failed write.

The current testnet deployment runs at **400 000**, not the 150 000 it was first armed with. At
150 000 the first deposit's callback was dropped silently and the deposit stayed in the burner;
that stranded balance is what `rescueSweep` recovered in the #4 proof. The 100 000 floor is a
minimum to stop a silently-dropped request, not a working value for a real sweep.

### Failed callbacks still cost money

A reverting callback burns gas and is billed. Repeated failures drain the forwarder, and a
drained forwarder stops receiving callbacks. Failures are not free to ignore.

### Amount exceeds balance

`executeSweep` clamps to the available balance rather than reverting. This handles a burner
drained by something else, or a log that outruns the balance. The swept amount may therefore
differ from the deposit amount; `TokensSwept.amount` records what actually moved.

### A hostile token re-entering the forwarder

The token address in a sweep comes from a caller-supplied callback payload, and
`executeSweep` writes `sweepCount` / `totalSwept` *after* `safeTransferFrom`. A token that
re-enters from inside `transferFrom` therefore observes the burner's balance already reduced
while the counters are still stale, and can start a second sweep that moves another full
`amount_`.

Both `executeSweep` and `rescueSweep` carry OpenZeppelin's `nonReentrant`. The tests that prove
it are built so the guard is the *only* thing that can refuse the re-entry: the hostile token is
deployed as both the callback proxy and the authorized callback sender, so the nested call clears
`onlyServiceProvider` and `onlyCallbackSender` exactly as a legitimate second callback would. The
assertion is on `ReentrancyGuardReentrantCall.selector`, so an incidental revert cannot satisfy
it. Verified load-bearing: with the modifier removed, the inner sweep succeeds and `sweepCount`
reaches 2 for a single deposit.

`rescueSweep`'s guard is defence in depth rather than the sole barrier — it drains the whole
balance before the re-entry runs, so an unguarded inner call would find nothing and hit
`NothingToSweep`. What the shared guard protects there is the `sweepCount` / `totalSwept`
bookkeeping that both entry points write.

### A failed sweep strands the deposit, and no later deposit recovers it

This is the most consequential failure mode, and it is arithmetic rather than a bug.

`executeSweep` moves `min(amount_, balance)`. The triggering log is the `Transfer` that just
credited the burner, so `amount_ <= balance` always holds at that moment: a sweep moves exactly
the triggering deposit and nothing else. Whatever was already in the burner is untouched.

The consequence is that "send another deposit to re-trigger the loop" **is not a recovery
path**. Depositing any amount, including more than the residue, sweeps only the new deposit and
leaves the old balance exactly where it was. Two Foundry tests pin this down:
`test_executeSweep_aLaterDepositCannotClearAnExistingResidue` and
`test_executeSweep_oversizedDepositStillLeavesTheResidue`.

So a deposit whose callback fails (no allowance, low gas, forwarder debt, one side disarmed) is
stranded until someone explicitly rescues it.

### Rescuing a residue

`SapuForwarder.rescueSweep(token, burner)` exists for exactly this case. It moves the burner's
whole balance to the cold wallet recorded in the armed rule.

Two properties are deliberate:

- **The destination is not a parameter.** It is read from `_rules[token][burner].coldWallet`,
  so the owner cannot redirect funds to an arbitrary address. Retargeting requires
  `armRoute`, which emits `RouteArmed` and is a visible act.
- **The allowance is still the authorization boundary.** `rescueSweep` uses
  `safeTransferFrom`, so the owner never gains the ability to move tokens the burner did not
  authorize this contract to move.

A rescue emits `TokensSwept` with `reactiveSender_ = address(0)`, which is how a rescue is
distinguished from a callback-driven sweep in the event stream.

### Deployments that predate `rescueSweep` cannot be rescued

`rescueSweep` was added after the first live deployment, and the forwarder has no proxy and no
upgrade path. A forwarder deployed before the change therefore has no recovery mechanism, and
the funds in its burners are unrecoverable by design.

**The current testnet deployment is past this point.** It was redeployed with the current source
and its forwarder carries the `rescueSweep` selector (`1d0e8bf2`), verified from deployed bytecode.
The four burners stranded by the earlier forwarder remain unrecoverable — that residue is
historical, not a property of the running stack — and the #4 proof recovered a residue on the
*new* stack through the app's real `rescueResidue`.

The app does not assume either way: it reads the deployed bytecode and looks for the
`rescueSweep` selector, then reports `supported`, `unsupported`, or `unknown`. When a deployment
is unsupported, the ledger says so per row instead of offering a button that would revert.

**Redeploying does not by itself recover the old balances.** Two independent obstacles remain,
and both are worth stating plainly because "just redeploy" is the intuitive answer and it is
wrong:

1. **The new forwarder has no rules.** `rescueSweep` reverts with `RouteNotArmed` until the
   owner calls `armRoute(token, burner, coldWallet)`. That is a single owner transaction and is
   recoverable, but it must be done per burner.
2. **The new forwarder has zero allowance, and the burner key may be gone.** `rescueSweep` still
   goes through `safeTransferFrom`, and the allowance is scoped to `allowance[burner][forwarder]`.
   An allowance granted to the old forwarder address does not carry over to the new one. Granting
   a new one requires a signature from the burner itself — an EIP-2612 permit or a plain
   `approve`. Burner keys are ephemeral by design: `scripts/arm-route.ts` generates one when
   `SAPU_BURNER_PRIVATE_KEY` is unset and never persists it, and the browser vault holds keys in
   a module-scoped `Map` that dies with the tab. If the key was not retained, the burner cannot
   authorize the new forwarder, and the tokens stay put no matter how many times the contract is
   redeployed.

So the recovery path for a pre-`rescueSweep` deployment is: redeploy, re-arm each burner, and
re-grant allowance **only if the burner key is still held**. Where it is not, the residue is
genuinely stuck, and the honest thing is to say so rather than to imply a redeploy fixes it.

### Subscription drift

`unsubscribe` requires an exact six-argument match. Any drift leaves the subscription live
**forever**, silently, and the operator keeps paying for events. SAPU funnels both calls
through a single stored `Subscription` struct to make drift structurally impossible — but a
manual `cast` unsubscribe with a typo'd argument would not be caught.

### `_CALLBACK_SENDER` mismatch

Immutable, no setter. A wrong address means the forwarder rejects every callback and must be
redeployed.

### Silent degradation: the three warnings that exist

Most of the failure modes above are silent on-chain. Three of them are now surfaced by the app:

- **Budget.** `/app/budget` shows a banner when the forwarder cannot pay for the next
  callbacks, or when either side carries debt. The banner is derived from the same numbers the
  cards show, so the two cannot disagree. The "low" threshold is 25 remaining sweeps - a policy
  choice, not a chain fact - and it is reported as `unknown` rather than guessed when the gas
  limit or gas price reads as zero.
- **Allowance.** The ledger shows each burner's live allowance judged against its live balance,
  and the `blocked by approval` card counts funded burners whose allowance cannot move the whole
  balance. This is the failure mode that arming checks exactly once and nothing repeats, so it
  is the most likely reason a previously healthy route goes quiet. The card deliberately does
  **not** claim the funds will move: on a deployment without `rescueSweep` a funded burner with
  a perfect allowance is still stuck, which is why the two figures are reported separately.
- **Cause per row.** The `why stranded` column names the first precondition that would stop the
  next sweep, checked in the order a sweep actually fails: a deposit the RSC refused as dust,
  then zero allowance, then a disarmed forwarder rule, then a revoked reactive route, then a
  destination disagreement, then a partial allowance. The dust cause is claimed only when the
  reactive chain emitted `DustIgnored` for that amount — the floor is owner-editable, so it is
  never inferred from the balance. A precondition that could not be read is reported as `unread`,
  never as `false`, because "the rule is disarmed" and "the rule could not be read" call for
  opposite repairs.

`not-reproducible` is the honest answer for the residue this product actually has: every
precondition currently passes, so the callback failed at some point in the past (gas, debt, a
transient revert) and nothing retried it. The app does not invent a live cause for it; it points
at `rescueSweep`, which is the only thing that moves those tokens.

Neither warning acts on its own: they report, and the operator decides. An app that silently
sent transactions to keep itself healthy would be a worse tool for a privacy product.

---

## 5. Key handling

Burner private keys live in a module-scoped `Map` in browser memory.

### What is enforced by construction

- Every vault function throws if `window` is undefined. There is no server-side path to a key.
- No `localStorage`, `sessionStorage`, cookie, IndexedDB, or network write. The key dies with
  the tab.
- `revealSecret` is the only accessor, and it is used only to sign an EIP-2612 permit.

### What is not protected

| Threat | Mitigated? |
| --- | --- |
| Server-side leakage | **Yes** — no server code path exists |
| Accidental persistence | **Yes** — nothing writes to storage |
| XSS in this app | **No** — script in the page can read the same memory |
| Compromised browser or extension | **No** |
| Malicious dependency | **No** |
| Tab crash / accidental refresh | **Now recoverable** — see below |

### Recovering a burner after the tab closes

Keys are still never persisted by default, but losing them is no longer necessarily fatal.
Three layers exist, in increasing order of what they cost the user:

**1. Prevention.** The Arm view shows the selected burner's live balance next to the burner
field, so an operator can see that a key-only wallet holds funds *before* reloading. While a
key is held and the burner is funded or armed, a `beforeunload` guard makes the browser ask
before discarding the tab.

Two details matter here, and both are easy to get wrong:

- The balance is read from `GET /api/balance?burner=…` rather than from `/api/ledger`. The
  ledger only knows burners that appear in the route registry or in a sweep/purge log, so a
  burner funded through the QR card but never armed is **absent** from it — and that is exactly
  the burner whose key is most costly to lose, because nothing on-chain will ever move its
  balance out. The dedicated endpoint reads `balanceOf` for any address.
- A failed read is reported as unknown and **keeps the guard armed**. It is never rendered as
  "empty", because zero is a claim about the chain. The rule lives in `domain/key-risk.ts` so
  the view cannot re-derive it differently.

**2. Opt-in backup.** "Back up key" writes a self-describing JSON file via a `Blob` download —
no network, no storage API. It is deliberately behind two clicks and a warning, because a key
file is a durable written link between the user and the burner, which is exactly what SAPU
otherwise avoids creating. `parseBurnerBackup` validates `kind`, `version`, address and key
length before restoring, so a truncated or foreign file cannot silently create an empty burner
that looks like the funded one.

**3. Deterministic derivation (the recommended path).** A burner can be derived from a wallet
signature instead of being generated randomly: `keccak256(personal_sign(derivationMessage(i)))`.
Nothing is written to disk, yet the burner is reproducible — the same wallet and index always
produce the same address. This is the only option that removes the trade-off rather than
choosing a side of it.

Properties that are checked rather than assumed:

- the signature is recovered independently with `recoverMessageAddress` and must match the
  account the wallet claims, so a signature the wallet did not produce is refused;
- the derived scalar must be non-zero and must build a valid secp256k1 account;
- the signed message is domain-separated and versioned, so a signature harvested by another
  site cannot be replayed here to reproduce the user's burner;
- the derivation is `keccak256` over the 65-byte signature, verified against a real signing
  flow, not merely unit-tested with fixed bytes.

The residual risk is unchanged and worth restating: derivation does not help if the burner key
was generated randomly and never exported. `generateBurner` remains the default because it is
the cheapest and the most private; derivation is the right choice when a burner may hold value
across a reload.

A production deployment handling real value should move key custody to a hardware wallet or a
dedicated signer. The in-memory vault is the right choice for a burner that is meant to be
disposable, and the wrong choice for anything else.

### The key is barely used

For a token that implements EIP-2612, the burner key signs exactly one thing: a permit. It never
signs a transaction, because the burner never sends one. This bounds the damage from key compromise
to "an attacker could re-grant an allowance", not "an attacker could move funds" — the forwarder
still enforces its armed rule and destination check.

The exception is a token with no permit: arming falls back to a plain `approve`, which the burner
must sign and send itself, so that one flow does put a transaction on chain and needs native gas in
the burner. It is opt-in per token, the preflight diff names the burner as the gas payer, and it
only runs when the loaded key matches the burner address. For permit-capable tokens — the default
and the common case — the statement above holds unchanged.

---

## 6. Operational limits

### Arming spans two owners, so one operator may hold only half the keys

The four arming steps are `onlyOwner` calls on two different contracts: `setForwarder` and
`registerRoute` on `SapuRSC`, `armRoute` on `SapuForwarder`. Nothing requires those two contracts
to share an owner, and the live testnet stack does not — `SapuRSC` is owned by the Reactive-network
key, `SapuForwarder` by the origin-chain deployer.

The app resolves authority per step rather than demanding one wallet own both, so an operator
holding one key can complete their half and resume the rest from a wallet holding the other. What
it cannot do is make a single browser wallet sufficient: if the two owners are different keys, no
single signature session finishes a fresh route. That is a property of the deployment, not a UI
limitation — deploying both contracts from one owner removes it.

A related consequence worth stating plainly: the pipeline reports which steps the connected wallet
can sign *before* anything is sent. Steps it cannot sign are named by contract, not hidden behind a
disabled button, because "you cannot do this" and "this is broken" must not look the same.

### RPC nodes cap `eth_getLogs` block ranges

Reactive's Lasna endpoint rejects any `eth_getLogs` whose span reaches 30,000 blocks
(`getLogs request exceeded max allowed range`). This is not in the ABI or the docs; it is a
property of the node, and it is not the same on every endpoint. It surfaced as `/api/watch`
returning `502` on every call, because the callback scan asked for a 50,000-block window in
one request.

Two things were wrong, and both are fixed:

1. **The range was not chunked.** Every log scan now goes through
   `infrastructure/logs.ts`, which splits a window into spans, paces requests per chain,
   retries rate limits, and bisects a range the node still rejects. Callers no longer need to
   know the limit.
2. **The callback scan started from an arbitrary lookback.** `observe()` now anchors the
   `CallbackRequest` scan to `NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK` when it is set, falling back
   to a bounded lookback when it is not. Before this, a callback older than the lookback was
   invisible, and the receipt silently lost its reactive leg — a completed sweep looked like
   it had only two hops.

The fallback lookback is still a real limit: with no deploy block configured, a callback older
than the window will not be found. Set the deploy block in production.

### RPC nodes also cap the *size* of a `getLogs` answer, and they do not say so clearly

A block-range cap is only one of two limits. The other is response size, and it is enforced by the
client as well as the node: viem refuses to buffer a body over 10 MB, so the request fails outright
rather than returning a partial result.

Measured on Base Sepolia, over the forwarder's deploy-to-head window:

| Request | Result |
| --- | --- |
| WETH, every event, one 1,000-block chunk | **10,499,600 bytes** — over viem's cap, request failed |
| USDC, `Transfer` only, 100,000-block span | rejected: "Invalid parameters were provided to the RPC method." |
| USDC, `Transfer` only, 50,000-block span | 11,027 logs, accepted |
| USDC / WETH / SAPU, `Transfer` filtered by recipient | 0 / 0 / 28 logs in 0.8–1.2 s |

Two consequences, both now handled:

1. **The scan filters at the node, not in memory.** Asking for every log a busy token ever emitted
   and discarding almost all of them is unbounded work. The deposit scan now sends both `Transfer`
   topics — the event signature *and* the recipient list, since `to` is indexed — so the node
   applies the filter before serialising anything.
2. **Size rejections shrink the chunk instead of failing the scan.** viem's oversized-response error
   is classified as a range limit. The gateway's generic "Invalid parameters were provided to the
   RPC method" is classified separately, with a bounded shrink budget, because that message is also
   what a genuinely malformed request returns — if the budget runs out the node's own error is
   rethrown, so a real failure is never disguised as a limit.

The remaining honest limit: if a single chunk at the smallest learnable size still exceeds the
response cap, the scan reports the token's logs as unavailable rather than silently returning none.
The ledger surfaces that as `coverage.originEvents = false` with the reason attached, not as "no
deposits".

### The configured token is optional, so a bad one is a warning, not an outage

`NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` names the Arm form's default, nothing more. SAPU's contracts are
token-agnostic, and the registry and ledger discover their tokens from `RouteRegistered` events — so
a deployment with no default token is a normal multi-token deployment, not a broken one.

It is still worth setting, and a value that does not answer `eth_getCode` is reported: as a
`warnings` entry on `/api/health` and an amber note on the Arm page, never as an `error`. Treating it
as required was a real bug — a mistyped default token made `verified` false and took every view
offline, which is the opposite of multi-token support. The one place the default is used in a scan
is guarded: `scanTokens` adds it to the `getLogs` filter set only when the code check confirmed a
contract there, because a filter on a codeless address is rejected by the gateway and would mark the
whole origin leg unscanned.

### One subscription per (token, burner)

Reactive subscriptions have no `OR` and no ranges. N burners across M tokens means N×M
subscriptions, each costing gas to create and REACT to service. There is no batching.

### Dust griefing

Anyone can send a dust amount to a watched burner, triggering a full reactive transaction and
a callback — both of which cost the operator money.

**The contract now enforces a floor.** `SapuRSC.minDeposit` (default `1` base unit) is compared
against the transferred amount in `react()`; anything below it is skipped and emits
`DustIgnored(burner, token, amount)`. The default keeps every real deposit working while
rejecting the `amount == 0` case outright. The owner can raise it with `setMinDeposit` for tokens
whose unit value is far below callback gas — 18-decimal tokens where 1 wei is worthless, or a
low-supply token where the smallest unit is already significant.

Why the floor is observable rather than silent: the previous code returned on `amount == 0` with
no trace, which made an ignored deposit indistinguishable from a route that was never
registered. `DustIgnored` turns every skip into a chain fact an operator can see and count.

What this does and does not fix:

- It **bounds** the griefing. An attacker must now spend at least `minDeposit` per forced
  callback, so the attack has a real unit cost instead of being free.
- It does **not** eliminate it. A determined attacker can still meet the floor and force spend;
  the mitigation is that the cost is now proportional and the owner can raise the floor.
- Raising the floor has a cost of its own: deposits between the old and new minimum become
  unsweepable and will sit in the burner. That is why the default is `1` rather than something
  tuned to gas.

An app-side `RouteRules.minDeposit` field used to exist. It was validated and unit-tested but
never read by anything — the deposit amount that reaches the contract is decided by whoever
sends it, so a client-side rule filters nothing. It was removed rather than left in place as a
safeguard that does not safeguard. The enforcement that actually works lives in the contract,
where the amount is known.

### There is no sweep cap, and there never was

An earlier version of this document claimed that "once `maxSweeps` is reached on a
non-continuous route, nothing re-arms it". That was wrong, and the code has been corrected
rather than the sentence.

`RouteRules` used to carry `maxSweeps` and `sweepContinuously`, and `domain/route-rules.ts`
exposed `shouldDisarm()` and `disarmReason()` to act on them. **Nothing in production ever
called those functions.** No store held a per-route rule set, and the contracts have no cap
parameter: `SapuRSC.sweepCount` is a global counter, not a per-burner one, so a per-route cap
could not be derived from chain state either. A cap enforced only in the browser would have
reset on every reload.

So the field, the two predicates and the module were deleted. What remains is the honest
statement: **SAPU sweeps for as long as the route is armed on both sides and the forwarder can
pay for the callback.** To stop it, disarm the forwarder rule and revoke the RSC route — both
are owner calls and both are visible as events.

The audit gate that should have caught this now does: it no longer counts a test file's import
as an import site, because tests prove behaviour, not deployment.

### No automatic re-arm

A disarmed route stays disarmed until an owner re-arms it. There is no watchdog, no retry, and
no scheduler. That is deliberate: an app that silently sent owner-signed transactions to
"heal" itself would be a worse tool for a privacy product.

### Owner is trusted

`registerRoute`, `armRoute`, `setForwarder`, and `setCallbackGasLimit` are all `onlyOwner`.
A malicious owner can retarget a route to their own cold wallet — though the forwarder's
independent destination registry means they must do it on **both** contracts, and doing so is
visible in `RouteArmed` / `RouteRegistered` events.

There is no timelock, no multi-sig, and no upgrade path. For a personal privacy tool that is
a reasonable scope; for a shared deployment it would not be.

### The Refusal Lab proves one token at a time

The lab runs its four cases against a single token: the one with the most armed routes,
preferring the configured token on a tie. That is a real scope limit on a page used as
evidence — it does not show `RouteNotArmed` / `NothingToSweep` for every asset the deployment
watches.

Two things bound how much that matters. The refusal branches are token-independent: the
forwarder looks up `ruleOf(token, burner)` and reverts identically whatever the asset, so the
contract behaviour is exercised, not the token's. And the pairing is now coherent by
construction — `domain/refusal-pairs.ts` derives both pairs from rows belonging to the probed
token, and the page names that token, so a reader is never told "SAPU was refused" while USDC
was tested. Running all four cases per token would multiply the simulation count by the
number of armed assets on every poll, which is the trade this makes instead.

---

## 7. What was deliberately not built

| Not built | Why |
| --- | --- |
| Native ETH sweeping | The brief specifies ERC-20 `Transfer` logs. Native transfers have no token contract and no `topic_2` in the same shape; it would be a separate subscription and a separate callback path. |
| Automatic permit acquisition | Requires the burner key at sweep time, which would mean holding keys server-side. Rejected on principle. |
| Multi-chain origins | `CHAIN_ID` is immutable per `SapuRSC`. One instance per origin chain. |
| Upgradeability | Immutable `_CALLBACK_SENDER` and no proxy. A bug means redeploying, which is the safer default for a contract that custodies approval. |
| Gas refunds | Out of scope. |
| Sweep caps / rate limits | A per-deposit or per-window cap would need storage the forwarder does not have, and the operator already controls which `(token, burner)` pairs exist. The bound that does exist is the dust floor. |
