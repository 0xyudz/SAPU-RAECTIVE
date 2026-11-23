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

**SAPU does not detect this automatically.** If the token lacks permit support,
`armWithPermit` reverts and the operator must use `approve()` — accepting the gas
requirement. The UI does not currently warn about this, which is a real gap.

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
| **Amount correlation** | The swept amount equals the deposit amount (unless clamped), so the two transfers are trivially pairable. |
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

### Failed callbacks still cost money

A reverting callback burns gas and is billed. Repeated failures drain the forwarder, and a
drained forwarder stops receiving callbacks. Failures are not free to ignore.

### Amount exceeds balance

`executeSweep` clamps to the available balance rather than reverting. This handles a burner
drained by something else, or a log that outruns the balance. The swept amount may therefore
differ from the deposit amount; `TokensSwept.amount` records what actually moved.

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

The app does not assume either way: it reads the deployed bytecode and looks for the
`rescueSweep` selector, then reports `supported`, `unsupported`, or `unknown`. When a deployment
is unsupported, the ledger says so per row instead of offering a button that would revert.

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
  and the `strand risk` card counts funded burners whose allowance cannot move the whole
  balance. This is the failure mode that arming checks exactly once and nothing repeats, so it
  is the most likely reason a previously healthy route goes quiet.
- **Cause per row.** The `why stranded` column names the first precondition that would stop the
  next sweep, checked in the order a sweep actually fails: zero allowance, then a disarmed
  forwarder rule, then a revoked reactive route, then a destination disagreement, then a
  partial allowance. A precondition that could not be read is reported as `unread`, never as
  `false`, because "the rule is disarmed" and "the rule could not be read" call for opposite
  repairs.

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
| Tab crash / accidental refresh | Not a threat, but keys are lost — this is by design |

A production deployment handling real value should move key custody to a hardware wallet or a
dedicated signer. The in-memory vault is the right choice for a burner that is meant to be
disposable, and the wrong choice for anything else.

### The key is barely used

The burner key signs exactly one thing: an EIP-2612 permit. It never signs a transaction,
because the burner never sends one. This bounds the damage from key compromise to "an attacker
could re-grant an allowance", not "an attacker could move funds" — the forwarder still enforces
its armed rule and destination check.

---

## 6. Operational limits

### One subscription per (token, burner)

Reactive subscriptions have no `OR` and no ranges. N burners across M tokens means N×M
subscriptions, each costing gas to create and REACT to service. There is no batching.

### Dust griefing

Anyone can send a dust amount to a watched burner, triggering a full reactive transaction and
a callback — both of which cost the operator money. `RouteRules.minDeposit` exists in the
domain layer to filter this, but **the contract does not enforce a minimum**. `SapuRSC.react`
requests a callback for any non-zero amount.

This is a real, unmitigated griefing vector: an attacker who knows a registered burner can
force the operator to spend REACT and ETH repeatedly for negligible gain. Mitigations would be
an on-chain `minDeposit` per route (not implemented) or accepting the cost as bounded and small.

### No automatic re-arm

Once `maxSweeps` is reached on a non-continuous route, nothing re-arms it. Re-arming is a
manual owner action.

### Owner is trusted

`registerRoute`, `armRoute`, `setForwarder`, and `setCallbackGasLimit` are all `onlyOwner`.
A malicious owner can retarget a route to their own cold wallet — though the forwarder's
independent destination registry means they must do it on **both** contracts, and doing so is
visible in `RouteArmed` / `RouteRegistered` events.

There is no timelock, no multi-sig, and no upgrade path. For a personal privacy tool that is
a reasonable scope; for a shared deployment it would not be.

---

## 7. What was deliberately not built

| Not built | Why |
| --- | --- |
| Native ETH sweeping | The brief specifies ERC-20 `Transfer` logs. Native transfers have no token contract and no `topic_2` in the same shape; it would be a separate subscription and a separate callback path. |
| Automatic permit acquisition | Requires the burner key at sweep time, which would mean holding keys server-side. Rejected on principle. |
| Multi-chain origins | `CHAIN_ID` is immutable per `SapuRSC`. One instance per origin chain. |
| Upgradeability | Immutable `_CALLBACK_SENDER` and no proxy. A bug means redeploying, which is the safer default for a contract that custodies approval. |
| Gas refunds | Out of scope. |
| An on-chain minimum deposit | Noted above as an unmitigated griefing vector; left unimplemented to keep `react()` cheap. |
