# Design decisions and the failures behind them

SAPU's source keeps the comments that state a **constraint**: what the code must do, and why
violating it is a bug. This file keeps the **history**: the specific failure, measurement or
incident that produced each constraint.

The split is deliberate. A comment wedged between two statements should answer "what must stay
true here?" for the next person editing that function. "This used to be `head - 5_000` and it
silently answered `receipts: []`" is a different kind of fact — true, load-bearing, and better
read in one place than repeated in nine files.

Nothing here is reconstructed from memory. Each entry names the incident that is recorded in the
commit history and, where relevant, the on-chain measurement that made it visible.

---

## How to use this file

- **Editing code?** Read the constraint comment in the file first. It is authoritative for
  behaviour. Come here only when you want to know why the constraint exists.
- **Tempted to remove a constraint comment?** Find its entry below first. Several of them
  describe failures that were invisible on-chain and only caught by correlation or by a browser.
- **Adding a constraint?** Add the one-line reason next to the code. Add an entry here only if
  there is a real incident behind it — not a preference.

---

## Chain reads and log scanning

### Chunk sizes are per chain, and measured

`logs.ts` used one `SPAN = 500_000n` for every chain. Nodes disagree: Reactive Lasna rejects
anything above 29,999 blocks with "getLogs request exceeded max allowed range", while the Base
Sepolia gateway accepts 5,000,000. A span above the cap does not fail loudly — it triggers the
bisect fallback, which spends a request discovering the limit on *every* scan. Five rejected
requests before the first one fitted, repeated on every rebuild: that is where the ledger's
cold-build latency came from.

Measured, not guessed: Lasna accepts 29,999 and rejects 30,000; Base Sepolia accepts 5,000,000 in
~2.5 s. Every unmeasured chain falls back to 10,000, which is below any cap seen in the wild.

### Chunk bounds are absolute, not window-relative

The scan walked `fromBlock, fromBlock + SPAN, …`, so every bound was a function of the caller's
window. With the ledger's `head - 50_000 .. head` window, the head advancing by one block changed
*every* chunk key and the cache never hit. Aligning chunks to multiples of the chunk size makes
the bounds a property of the chain: as the window slides, only the chunk it enters is new.

### Both `Transfer` topics are filtered at the node

The scan asked for every log the token ever emitted and discarded all but the handful addressed
to a known burner. That is unbounded work. Measured on Base Sepolia: a single 1,000-block chunk of
WETH's unfiltered `Transfer` stream returned 10,499,600 bytes — over viem's 10 MB response cap.
The request failed, the whole origin leg was marked unscanned, and the ledger claimed there were
no deposits for *any* token. Filtering `Transfer` alone was still not enough: the USDC gateway
rejected that window with "Invalid parameters were provided to the RPC method".

Filtering the recipient as well is correct and cheap, because `Transfer`'s `to` is indexed:
`args: { to: burners }` becomes a topic OR-list the node applies before serialising anything. The
same three tokens then answered in 0.8–1.2 s with 0, 0 and 28 logs.

### "Invalid parameters" is treated as a bounded size rejection

Measured on Base Sepolia: `eth_getLogs` for USDC over 100,000 blocks answers "Invalid parameters
were provided to the RPC method", while the same request over 50,000 blocks succeeds with 11,027
logs. The request is well-formed in both cases — the gateway is refusing the *answer*.

The same message is also what a genuinely malformed request returns. Shrinking those wastes 24
halvings and then reports "could not fit any block range", hiding the real cause. So the class
gets a small shrink budget (3), and when the budget runs out the original error is rethrown
unchanged: a size problem is fixed by one or two halvings, while a malformed request fails
identically at every size and the operator sees the node's own words.

### `getDecodedLogs` exists so callers cannot bypass the scan

The sweep orchestrator and the callback lookup need viem's decoded `args`. Calling
`client.getLogs` directly skips chunking, pacing, retry, range learning and chunk caching, so a
50,000-block lookback goes out as one request and Lasna rejects it outright. Routing through the
same scan means every caller inherits the same protections.

### Retry patterns are `\b`-delimited

Bare `429|502|503|504` matches inside viem's error message, which embeds the request including
the `to:` address. The live RSC's hex contains `429`, so a permanent `TypeError`
("account.signTransaction is not a function") was classified as a rate limit and retried — a
one-shot programming error became six identical failures.

### The `debt()` retry must sit inside the `try`

Wrapping the call in `withRpcRetry` from outside cannot help: the `catch` swallows the transport
failure first, so the retry sees a successful call returning `null`. Measured on the public
gateways, `debt()` intermittently answers "HTTP request failed" while the next attempt returns 0,
so the budget page reported `forwarderDebt: null` (unreadable) for a deployment that was not in
debt at all.

---

## The ledger

### Correlation is a pure function, separate from the indexer

This is the part of the ledger that can be wrong in a way nobody notices. A sweep matched to the
wrong deposit still renders a complete row with plausible numbers; an orphaned deposit that is
silently dropped still renders an empty ledger. Neither throws, and neither is visible from the
chain alone. It lived inside `buildIndex` wrapped around four `eth_getLogs` calls, which meant the
only way to test it was to stand up a chain.

### A sweep claims the whole run of deposits that sum to its amount

The forwarder sweeps `balanceOf(burner)`, so everything that arrived since the previous sweep and
has not left yet is in the burner when the sweep runs. When several deposits were sitting there,
the sweep amount is their sum.

Claiming only the single earliest deposit of a matching amount was wrong for exactly that case. On
the live deployment a 1.5 SAPU sweep cleared three 0.5 SAPU deposits; the ledger credited one and
showed the other two as `reactive-only` — i.e. as stalled deposits that were in fact already gone.
The rescue sweep that emptied the dust residue was likewise attributed to an earlier deposit that
a *different* transaction had already swept, so the row that needed an explanation was the one
left unexplained.

### There is no loose reactive-event fallback

Attaching *any* event for the pair, in array order, to a deposit with no exact match showed an
unswept deposit with a newer deposit's reactive transaction as its own trigger — a sequence that
never happened.

### Scan coverage is a structural flag, not a regex over `error`

The page decided "reactive logs are missing, do not claim there is no reactive proof" by matching
`/PurgeTriggered logs unavailable|CallbackRequest logs unavailable/` against `index.error`. That
string is a human-readable concatenation and five different failures can appear in it (both head
reads, `TokensSwept`, `PurgeTriggered`, `CallbackRequest`, `Transfer`). The regex covered two, so a
failed reactive **head** — which skips every reactive query — left the page asserting "no reactive
proof" for every row, and a failed `Transfer` scan made the counts read as a quiet ledger.

### Four absence claims were printed at once

The empty-ledger branch said "no deposits or sweeps in the scanned window" even for a scan that
never reached a head. An empty result is evidence of absence only when the window was actually
covered.

### Amounts are formatted by one function, with no `?? 0` / `?? 18`

Three surfaces printed a token amount with a scale that may be unreadable: the ledger's amount
column, its live-balance cell, and the "still in burners" summary. Each carried its own fallback.
`decimals()` returning null is not "decimals are zero": `formatUnits("1230000", 0)` prints
`1230000`, which a reader takes as 1.23 million USDC when it is 1.23 USDC. Substituting 18 is
worse — a number off by twelve orders of magnitude.

### `strand-cause` replaces "reactive-only"

"Reactive-only" is a statement about the event history, not a cause, and the causes need
different responses: a missing allowance needs a new permit, a disarmed rule needs re-arming, a
historical callback failure needs a rescue.

---

## The watch endpoint

### The default window is the deploy block, not `head - 5_000`

`/api/watch` defaulted to the last 5,000 origin blocks. The live swept burners are ~1.7M blocks
behind the head, so a burner the ledger had already classified as `complete` was answered
`receipts: []` — the same body a never-funded burner gets. No unit test could catch it: the bug
lived in the default, not in the correlation logic.

"Nothing was found" is a claim about the chain and may only be made when the search covered
everything the deployment could have produced. `WatchWindow` carries the evidence for that claim.

---

## Token identity

### Token metadata is read per token, never from configuration

The app took `symbol`/`decimals` from `NEXT_PUBLIC_SAPU_TOKEN_*`. That is only correct while a
deployment has exactly one token, and it silently mislabels every row the moment a second token
exists — the ledger would print token B's amounts under token A's ticker and decimals.

The Arm page had the same defect from `/api/health`: typing a different address armed a route
whose recorded `tokenSymbol`/`tokenDecimals` described some other asset — the exact fabrication
the guard in `armRoute` claims to prevent.

### `tokensOf` is a real call

The registry row carried a hardcoded `rscTokens: []`, so the UI printed `tokensOf: 0` next to a
live route. A fabricated zero is worse than no number at all. `token-visibility.test.ts` reads the
registry source and fails if `rscTokens: []` returns or if the `tokensOf`/multicall calls vanish.

### The refusal pairs are chosen as pairs

The refusal lab picked the burner from any row with `forwarderArmed` and took the token from
configuration — two independent choices over a fact that is a *pair*. A burner armed only for USDC
was simulated against SAPU, so `executeSweep` reverted `RouteNotArmed` while the card promised
`NothingToSweep`. On the live deployment the chosen burner happened to be armed for all three
tokens, so the output looked correct for the wrong reason.

### The token field needs three states, not two

The mode was derived from one question — "does this value match an option?" — and anything that
did not match was treated as "the operator chose Other ERC-20". That is wrong for the most common
state of all: the moment before the registry answers.

On a cold load the value is empty and `choices` is empty, so nothing matched, so the field
announced "Other ERC-20" and opened an empty address box underneath it. For roughly a second a
visitor saw a form asking them to paste a token contract address, then it silently rearranged
itself into a three-token dropdown. Nothing was broken, but the page looked like it had lost its
configuration.

`ready` is a parameter rather than something inferred from `value` because the escape hatch works
by clearing the value: "empty" means both "nothing has arrived yet" and "the operator asked to
type an address", and only the caller knows which.

### The token picker is a dropdown with an escape hatch

The contract accepts any ERC-20, so the field has to accept an arbitrary address — but asking an
operator to paste a 42-character hex string is how a route gets armed against the wrong asset, or
against an address that is not a token at all. A new asset is precisely one that has never been
routed, so it cannot be in a list built from on-chain history; `CUSTOM_TOKEN_VALUE` keeps the
free-text path reachable.

---

## Arming

### Authority is per step, because the two contracts need not share an owner

`setForwarder` and `registerRoute` are `onlyOwner` on `SapuRSC`; `armRoute` (and the burner-signed
`approve` that sometimes precedes it) is `onlyOwner` on `SapuForwarder`. The live testnet stack has
different keys for each, because `SapuRSC` is deployed from a Reactive-network key while
`SapuForwarder` is deployed from the origin-chain key.

The Arm page required **one wallet to own both**, which no wallet can satisfy in that deployment.
The Arm button was therefore disabled for every possible operator, and the only way to arm a route
was a script holding both keys. That is not a permission check; it is a dead end.

### `armGate` is not a boolean, and `canArmAnyStep` must not come back

`canArmAnyStep` answered "is at least one write step signable?". `armRoute` executes the steps in a
fixed order and stops at the first it cannot complete, so the two questions disagree exactly when
it matters: a wallet owning only `SapuForwarder` on a fresh route passed the predicate, the button
was enabled, and the very first transaction (`setForwarder` on `SapuRSC`) reverted with
`OwnableUnauthorizedAccount`. The button promised progress that could not happen.

### "Could not be read" is not "does not own"

The owner of each contract is an `eth_call`. When that call fails — a rate-limited node, a proxy
that has not answered — the owner is `null`, and saying the wallet "does not own SapuRSC" is a
claim about both the wallet and the chain that nobody observed. The operator's next action
differs: connect another wallet, or retry the read.

### There is no `busy` prop on the preflight panel

A `disabled={busy}` fed by the page's operation flag deadlocks every write flow. The page sets
that flag *before* calling the use case, and the use case blocks on `confirm()` — the promise the
panel's button resolves. By the time the panel rendered, `busy` was already true and **Approve was
permanently disabled**: arming, rescuing, revoking and every budget action could only ever be
cancelled.

The flag was also unnecessary: `approve()` clears the diff synchronously, so the panel unmounts on
the first click and a second click finds no resolver. The button cannot be double-fired.

---

## Keys

### Burner keys are derived from a signature

Burner keys were `generatePrivateKey()` stored in a module-scoped `Map`. A reload destroyed them,
and an address cannot be turned back into a key, so any burner still holding a balance became
unreachable. `rescueSweep` needs the burner's own signature to grant a fresh allowance, so "the
owner can always rescue it" is false once the key is gone.

Writing the key to a `.txt`/`.json` fixes the loss but breaks the product's central promise: SAPU
exists to stop the burner from being linked to the user, and a key file on disk is a durable,
often cloud-synced, written link between the two. Deriving from a wallet signature keeps nothing
on disk while staying reproducible.

### The backup file is opt-in

It is the escape hatch, not the default, for the same privacy reason. It is a plain,
self-describing record with no encryption: the key is already in the clear in the browser's
memory, and encryption here would be security theatre that invites careless storage.

### `SAPU_BURNER_ADDRESS` alone is not enough to select a burner

`arm-route.ts` gated on `SAPU_BURNER_ADDRESS` alone, so a persisted `SAPU_BURNER_PRIVATE_KEY` was
read into `burnerKey` and then immediately overwritten by a fresh `generatePrivateKey()`. Every
run armed a brand-new burner and the operator silently lost the ability to sign a later permit for
the one actually in use. Deriving the address from the key keeps the two in step.

### Losing the tab's key is only a risk sometimes

The `beforeunload` guard is deliberately not a nag. A tab full of freshly generated, empty,
unarmed burners closes silently — those keys are cheap to regenerate and nothing on-chain refers
to them. Balance unreadable is treated as funded, because "unknown" must never be rendered as
"empty".

---

## Stale reads

### Every polled payload is stamped with its url

The Arm view polls `/api/balance?burner=…`. When the operator switches burners the url changes,
but a plain `useState` keeps the previous payload until the next response lands. For a few hundred
milliseconds the panel rendered burner A's balance under burner B's address — a claim about the
chain that was simply false.

### The footer reads the chain pair from config

The footer hardcoded "Base Sepolia 84532 → Reactive Lasna 5318007", which was true for exactly one
deployment. On any other origin chain — or on mainnet — it labelled the running app with two
chains it was not using, so a reader checking the footer to confirm which chain their funds were
on got a confident wrong answer.

---

## Configuration surfaces

### The chain table is the only place a chain fact may live

SAPU hardcoded Base Sepolia and Reactive Lasna in a dozen modules, which made "supports every
Reactive chain" impossible: the callback proxy address, the explorer, the multicall transport and
the wallet's `wallet_addEthereumChain` payload were all chain literals. The proxy address in
particular is *per chain*, and a wrong one makes `onlyServiceProvider` reject every callback.

`wallet_addEthereumChain` is built from that table for the same reason, and refuses when no RPC
endpoint is configured: adding a network with an empty `rpcUrls` array leaves the wallet on a
chain it cannot talk to.

### The RPC table is written out literally

Next.js only inlines environment variables into the browser bundle when it can see the access
statically. A computed `process.env[\`NEXT_PUBLIC_RPC_URL_${id}\`]` reads `undefined` in the
client, so the wallet's `wallet_addEthereumChain` call would be handed an empty URL and silently
add a broken network.

### `"token"` without an override is an error

`NEXT_PUBLIC_SAPU_TOKEN_ADDRESS` is the deployment's *default* token, not the set of tokens SAPU
handles. Silently falling back to it is how a USDC route was once armed against SAPU's allowance.

### The network switch has no third state

A testnet/mainnet switch invites a specific lie: letting the operator pick "mainnet" and rendering
the testnet numbers underneath it. Nothing would look wrong — the page would fill with plausible
blocks and balances — and the operator would believe they were reading mainnet. "Probably fine"
is exactly the claim `network-scope.ts` exists to prevent.

---

## Protocol details

### The EIP-2612 `version` cannot be hardcoded

The domain separator is
`keccak256(abi.encode(typeHash, keccak256(name), keccak256(version), chainId, token))`, and the
spec never says what `version` must be — it is whatever the token's author put in the constructor.
Most use `"1"`; Circle's USDC uses `"2"`. Signing with the wrong version produces a well-formed
signature over the wrong digest, so the token reverts with `EIP2612: invalid signature` and gives
no hint which field was wrong. The version is found by matching `DOMAIN_SEPARATOR()` against a few
plausible candidates — a real read, not a guess.

### "Not an ERC-20" and "the RPC never answered" are different claims

Collapsing them into `null` tells an operator their token is broken because a public gateway
returned 429 — a false claim about the chain, which is the one thing this app must never make.
`getCode` runs first because viem's error for a non-token is ambiguous: an address with no code and
a contract lacking `symbol()` both surface as `ContractFunctionExecutionError`, and a flaky node
can return `0x` for a perfectly good token.

### The deployed-token report is separate from the swept asset

Those are the same thing only when SAPU deployed the token itself. The deploy script reports them
separately so a reused asset is never described as SAPU's own.

### `minDeposit` and `maxSweeps` are not route rules

`maxSweeps` has no store, and `SapuRSC.sweepCount` is a global counter rather than a per-route one.
`minDeposit` was validated and unit-tested, but `SapuRSC.react` requests a callback for any
non-zero amount, so no deposit was ever filtered by it. A rule that cannot be enforced and is
never read is dead weight, not a safeguard. The dust-griefing vector `minDeposit` was meant to
address is real and is recorded as an unmitigated limitation in `docs/LIMITATIONS.md` §6.

---

## Verification

### The dead-export scan includes `components/`

Excluding it is a blind spot, and that blind spot is exactly how a whole unreferenced UI card
(`QrDepositCard`) survived with a green gate. A component nobody renders is not shipped, no matter
how well it is tested.

### The write path check is stricter than a count

Counting alone lets a second, simulation-free send path be added as long as a matching use case is
added alongside it. The audit requires every module calling `writeContract` to also call
`simulateCall`.

### The browser check exists because HTTP 200 is not a working page

Every earlier "all green" claim was made at the HTTP level. A React render error, a failed
`/api/*` fetch, or an unhandled promise rejection all leave the status at 200 while the operator
sees a blank or half-rendered view. The ledger's token column is rendered client-side, so it does
not exist in the server HTML at all and an HTTP check cannot see whether it ever appeared.

`e2e-views.mjs` exits non-zero when a browser cannot be launched. Silently passing when nothing ran
is the exact failure mode the script was written to remove.

### The multi-token proof needs a real sweep, not just arming

`prove-multi-token.mts` proves `armRoute` can arm USDC and WETH, but no non-demo token had ever
been *swept*, so the end-to-end multi-token path was unproven. `prove-token-sweep.mts` closes it
with a real transfer into an armed burner, a real callback, and a real `executeSweep`. Base
Sepolia's WETH predeploy is a real contract, so the tokens are wrapped native ETH the deployer
actually spent — nothing is minted by this repository.
