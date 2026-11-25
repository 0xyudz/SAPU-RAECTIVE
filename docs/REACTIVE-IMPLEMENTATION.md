# REACTIVE-IMPLEMENTATION

How this repository implements the Reactive Network model, file by file.

Every rule in this document is quoted from the official documentation at
[docs.reactive.network](https://docs.reactive.network/) — specifically
[Getting Started](https://docs.reactive.network/), [Reactive Contracts](https://docs.reactive.network/reactive-contracts),
[Callback Contracts](https://docs.reactive.network/callback-contracts),
[Origins & Destinations](https://docs.reactive.network/origins-and-destinations), and
[Economy & System Interactions](https://docs.reactive.network/economy).

This page exists so a reviewer can check the implementation against the protocol without having to
trust the README. Each section names the official rule, the exact code that satisfies it, and the
test that pins it. Where SAPU does something the docs do not prescribe, it says so.

---

## 0. The model in one paragraph

A **reactive contract** is "an ordinary Solidity contract with one extra ability: it can subscribe
to events on any chain Reactive Network monitors. When a matching log appears, the system contract
calls `react()`, where the contract can update its state, request a callback on another chain, or
change its own subscriptions." A **callback contract** "lives on a destination chain and receives
calls triggered by a reactive contract … and that proxy calls your contract. From your contract's
side, nothing exotic happens: it's an ordinary function call from an ordinary address."

SAPU is exactly that pair: `SapuRSC` is the reactive contract, `SapuForwarder` is the callback
contract, and the "thing worth automating" is an ERC-20 landing in a burner wallet.

---

## 1. Reactive contract: inheritance

> **Official:** "Inherit `AbstractReactive`. It supplies `SYSTEM`, `REACTIVE_IGNORE`, and
> `onlySystem`, and brings `AbstractPayer` with it."

SAPU does not inherit `AbstractReactive` directly. It inherits one intermediate base that inherits
it, because two things are missing from the official base for this use case:

| Need | Why the official base is not enough | Where it is added |
| --- | --- | --- |
| Pause that actually stops billing | Subscriptions live in the node. Setting a boolean would still bill every matching log. Pausing must `unsubscribe`. | `AbstractPausableReactiveContract.pause()` |
| Subscription bookkeeping | The node's subscriptions cannot be read back on-chain, so the contract must remember its own criteria to be able to unsubscribe them | `_subscriptions`, `_subscriptionIds` |

```solidity
// contracts/src/base/AbstractPausableReactiveContract.sol
abstract contract AbstractPausableReactiveContract is AbstractReactive, Ownable {
```

`AbstractReactive` still supplies `SYSTEM`, `REACTIVE_IGNORE` and `onlySystem`, and still brings
`AbstractPayer` — the inheritance chain is intact, only extended.

**Verified:** `contracts/test/AbstractPausableReactiveContract.t.sol`.

---

## 2. Reactive contract: `react()` and `onlySystem`

> **Official:** "Implement `react()` with `onlySystem`. … The modifier checks `msg.sender` against
> the service provider, which for a reactive contract is `SYSTEM` at
> `0x8888888888888888888888888888888888888888`, and reverts with `NotAuthorized` for anyone else.
> Without it, a caller can hand your contract a fabricated log record."

```solidity
// contracts/src/reactive/SapuRSC.sol
function react(LogRecord memory log_) external onlySystem whenNotPaused {
```

`onlySystem` is inherited from `AbstractReactive` and is a thin alias over
`AbstractPayer._onlyServiceProvider()`. `whenNotPaused` is SAPU's addition and is applied **after**
`onlySystem`, so an unauthenticated caller is rejected before the pause check can leak state.

**Verified:** `test_react_revertsWhenNotSystem` (pranks as an attacker and expects a revert).

---

## 3. Reactive contract: `LogRecord` decoding

> **Official:** "`data` holds the ABI-encoded non-indexed parameter(s), and nothing else. `opCode`
> is how many topics the original log had, so a `LOG3` arrives with `opCode` of `3`. … A zero in a
> topic position doesn't prove the log had fewer topics, since a topic can legitimately be zero.
> An ERC-20 mint emits `Transfer` with `from` as `address(0)`. `opCode` is the reliable count."

SAPU consumes a standard ERC-20 `Transfer`, which is a `LOG3`:

| `LogRecord` field | Value for a deposit | SAPU's use |
| --- | --- | --- |
| `topic0` | `0xddf252ad…b3ef` | routed first, so other subscriptions fall through cheaply |
| `topic1` | `from`, left-padded | ignored — anyone may fund a burner |
| `topic2` | `to`, left-padded | **the burner**; `address(uint160(log_.topic2))` |
| `topic3` | zero (unused) | ignored |
| `data` | `abi.encode(uint256 value)` | decoded as the deposit amount |
| `opCode` | `3` | checked before decoding |
| `contractAddress` | the token | used as the route key |
| `blockNumber` | origin height | recorded in `PurgeTriggered` for the ledger |

```solidity
if (log_.topic0 != TRANSFER_TOPIC_0) return;
if (log_.opCode != 3) return;

address token = log_.contractAddress;
address burner = address(uint160(log_.topic2));

Route storage route = _routes[token][burner];
if (!route.active) return;

uint256 amount = abi.decode(log_.data, (uint256));
```

The `opCode` check is not decorative. A `LOG1`-encoded `Transfer` packs every parameter into `data`,
so decoding `topic2` as the recipient would attribute a deposit to the wrong burner — or to
`address(0)`, which is also what an unused topic looks like.

**Verified:** `test_react_ignoresNonLog3Encoding`, `test_react_ignoresUnregisteredBurner`,
`test_react_ignoresTransferFromBurner`.

---

## 4. Reactive contract: falling through instead of reverting

> **Official:** "Logs that don't match should fall through and cost nothing extra. Reverting as a
> filter is a mistake: the system contract catches it, emits `ReactiveContractReverted`, and still
> bills you for the gas burned."

Every non-match in `SapuRSC.react` is a `return`, never a `revert`. The only reverts reachable from
`react()` are genuine misconfiguration (`ForwarderNotSet`) — a state that cannot be reached in a
correct deployment and that an operator must see.

`whenNotPaused` reverts with `ContractPaused`, which is a deliberate exception: it fires only for a
delivery that arrives in the window between `pause()` and node-side teardown, and reverting is
cheaper than executing the body. The docs' advice applies to *filtering*, which SAPU does with
`return`.

**Verified:** `test_react_ignoresWrongTopic0`, `test_react_ignoresUnregisteredBurner`,
`test_react_ignoresOtherToken`; `test_pause_unsubscribesEverything` covers the paused-delivery
revert.

---

## 5. Subscriptions: the six criteria

> **Official:** "A subscription tells Reactive which logs should reach your contract. Each one is a
> set of criteria passed to `SYSTEM.subscribe()`, and both methods take the same six arguments."

> **Official:** "Each criterion narrows or widens independently. `topic0` is normally the event
> signature hash, with topics 1-3 holding indexed parameters, and any position can be left open."

The docs give the wildcards as a table; reproduced here in the same shape:

| Criterion | Wildcard | Matches |
| --- | --- | --- |
| `chainId_` | `0` | any chain |
| `contract_` | `address(0)` | any contract on the specified chain |
| `topic0_` to `topic3_` | `REACTIVE_IGNORE` | any value in that position |

```solidity
// contracts/src/reactive/SapuRSC.sol — registerRoute
_addSubscription(
    Subscription({
        chainId: CHAIN_ID,                    // specific
        contractAddress: token_,              // specific
        topic0: TRANSFER_TOPIC_0,             // specific
        topic1: REACTIVE_IGNORE,              // any sender
        topic2: uint256(uint160(burner_)),    // specific: only deposits TO the burner
        topic3: REACTIVE_IGNORE               // unused by ERC-20 Transfer
    })
);
```

> **Official:** "At least one criterion has to be specific. Subscribing to every event on every
> contract on every chain isn't allowed."

Four of SAPU's six criteria are specific, so the rule is satisfied with margin.

> **Official:** "Criteria match exact values. There are no ranges, comparisons, or bitwise filters."

This is why the burner must be narrowed as a *padded integer*, not as a prefix:
`uint256(uint160(burner))` is the exact 32-byte topic value of an indexed `address`. A range of
burners cannot share a subscription.

> **Official:** "There's no way to express `OR` within a single subscription. Call `subscribe()`
> once per combination you want."

This is why arming three tokens for one burner produces three subscriptions, and why
`subscriptionCount()` on the live deployment reads `4` for four `(token, burner)` pairs rather than
`1` per burner.

**Verified:** `test_registerRoute_subscribesWithExactCriteria` asserts each of the six arguments
individually, including that `topic1` and `topic3` are exactly `REACTIVE_IGNORE`.

---

## 6. Subscriptions: node-side state and the exact-match trap

> **Official:** "Subscriptions live in the node, not in contract storage. You can't read your own
> back on-chain, so track them yourself if your logic depends on knowing them."

> **Official:** "`unsubscribe()` removes a subscription matching all six arguments exactly. Any
> drift between the two calls leaves the subscription in place and fails silently."

This is the sharpest edge in the protocol, and the one piece of real design SAPU adds on top of the
official base. A subscription that is never unsubscribed keeps billing its contract on every
matching log — forever, and silently.

The fix is a single struct, stored once, replayed byte-for-byte by both directions:

```solidity
// contracts/src/base/AbstractPausableReactiveContract.sol
function _subscribe(Subscription memory subscription_) internal {
    SYSTEM.subscribe(
        subscription_.chainId,
        subscription_.contractAddress,
        subscription_.topic0,
        subscription_.topic1,
        subscription_.topic2,
        subscription_.topic3
    );
}

function _unsubscribe(Subscription memory subscription_) internal {
    SYSTEM.unsubscribe(/* the same six fields, from the same struct */);
}
```

Because both functions take the identical struct, drift is impossible by construction rather than
by discipline. The id is a hash of the criteria (`subscriptionId`), so duplicate registration is a
no-op instead of a second paid `subscribe()` call.

> **Official:** "Two identical subscriptions behave as one, and you pay gas for both calls."

`_addSubscription` deduplicates on the criteria hash before touching the node, so SAPU never pays
twice for the same criteria set.

**Verified:** `test_pause_unsubscribesEverything` (asserts `system.subscriptionCount() == 0` after
pausing) and `test_unpause_resubscribesSameCriteria` (asserts `topic2` and `topic0` replay exactly).
Deduplication is pinned by `test_addSubscription_isIdempotentForIdenticalCriteria`.

---

## 7. Subscriptions: changing them at runtime, and settling debt first

> **Official:** "A contract that stops and restarts should settle up before resubscribing, since a
> contract in debt receives nothing."

`unpause()` calls `_coverDebt()` **before** resubscribing:

```solidity
function unpause() external onlyOwner {
    if (!paused) revert ContractNotPaused();
    paused = false;
    _coverDebt();
    // ... resubscribe every tracked criteria set
}
```

Order matters. Resubscribing first would ask the node to deliver events to a contract that is still
blacklisted for debt, and those deliveries would be dropped.

**Verified:** no test asserts the ordering itself — `test_unpause_resubscribesSameCriteria` covers
the replay, and `test_coverDebt_settlesOutstandingDebt` covers debt settlement on its own. The order
is visible in `AbstractPausableReactiveContract.unpause`, where `_coverDebt()` is the first statement
after the flag flips. This is a known gap in the test suite, stated here rather than papered over.

---

## 8. Requesting a callback

> **Official:** "Reach for `requestCallbackV_1_0()`, which takes the struct directly with no manual
> encoding or version flag."

```solidity
// contracts/src/reactive/SapuRSC.sol
SYSTEM.requestCallbackV_1_0(
    ISystemContract.CallbackConfiguration_V_1_0({
        chainId: CHAIN_ID,          // destination network
        recipient: forwarder,       // target contract on the destination chain
        gasLimit: callbackGasLimit, // execution gas limit
        payload: payload            // ABI-encoded function call
    })
);
```

> **Official:** "Emitting a `Callback` event still works for contracts that already rely on it, but
> it's deprecated."

SAPU uses the current API. The library's own source says the same thing in
`IReactive.sol`:

```solidity
/// @dev Deprecated and should not be used for new development. Use the system contract's
/// `requestCallback()` and `requestCallback_V_*_*()` methods.
event Callback(...);
```

This is a deliberate, documented deviation from the buildathon brief, which asks for
`emit Callback(...)`. Shipping the deprecated path would have been following the letter of the
brief against the current protocol.

> **Official:** "Either method causes the system contract to emit `CallbackRequest`, which the
> network picks up to submit the destination transaction."

That event is SAPU's **Tx2 proof artefact**. Its three indexed fields — destination chain,
requesting reactive contract, recipient — are exactly what the ledger filters on to find callbacks
aimed at this deployment's forwarder.

**Verified:** `test_react_emitsCallbackForRegisteredBurner` asserts the full payload and
`gasLimit == 150_000`.

---

## 9. The payload's reserved first word

> **Official:** "Reactive Network replaces the first 160 bits of the payload with the address of the
> reactive contract that requested the callback, so the destination can authenticate the sender.
> Your payload has to declare an `address` there and pass `address(0)` as a placeholder, whatever
> you name it in Solidity. Forgetting it is the most common way to break a callback."

```solidity
bytes memory payload = abi.encodeWithSignature(
    "executeSweep(address,address,address,address,uint256)",
    address(0),        // <- overwritten by the proxy with SapuRSC's address
    token,
    burner,
    route.coldWallet,
    amount
);
```

Three consequences, all visible in the code:

1. `SapuForwarder.executeSweep` declares `address reactiveSender_` as its **first** parameter. The
   name is arbitrary; the position and type are not.
2. The selector is untouched — only bytes `[16..35]` of the payload change — so the function that
   runs is still `executeSweep`.
3. `burner` had to be added to the signature. The docs do not prescribe a payload shape; SAPU needs
   the burner to know which address to pull from and which rule to check.

The test double reproduces the injection byte-for-byte at the correct offset. It is a byte-indexed
loop over `[16..35]`, not a re-encode, because a re-encode would prove nothing about the real
proxy's behaviour — the real proxy mutates the encoded bytes in place. `docs/SPEC-REACTIVE-LOOP.md`
§5 records that an earlier draft of this simulator wrote at the wrong offset, which let the
forwarder's authentication pass for the wrong reason.

**Verified:** `CallbackProxySimulator.deliver` overwrites bytes `[16..35]`;
`test_executeSweep_revertsWhenCallbackSenderIsWrong` proves a wrong injected address is rejected
with `CallbackNotAuthorized`.

---

## 10. Callback contract: inheritance and the two guards

> **Official:** "Inherit `AbstractCallback` with two constructor arguments. `callbackProxy_` is the
> callback proxy on the chosen chain, which becomes the contract's service provider for payment.
> `callbackSender_` is the reactive contract you're authorizing. Both are stored immutably."

```solidity
// contracts/src/destination/SapuForwarder.sol
contract SapuForwarder is AbstractCallback, ISapuForwarder, Ownable, ReentrancyGuard {
    constructor(IPayable callbackProxy_, address callbackSender_, address initialOwner_)
        payable
        AbstractCallback(callbackProxy_, callbackSender_)
        Ownable(initialOwner_)
    { ... }
```

> **Official:** "`onlyServiceProvider` asks whether the caller is the callback proxy. Without it,
> anyone can call `myCallback()` directly and pass whatever address they like as the first argument,
> defeating the second check entirely."
>
> "`onlyCallbackSender(reactive_)` asks whether the injected address is the reactive contract you
> authorized. Without it, any reactive contract on the network can drive your callback through the
> legitimate proxy."
>
> "Together they establish that the call came through the network and originated from the contract
> you trust. Use both, always."

```solidity
function executeSweep(
    address reactiveSender_,
    address token_,
    address burner_,
    address coldWallet_,
    uint256 amount_
) external nonReentrant onlyServiceProvider onlyCallbackSender(reactiveSender_) {
```

Both guards, in that order. Neither is redundant:

| Guard | Question | If omitted |
| --- | --- | --- |
| `onlyServiceProvider` | is `msg.sender` the callback proxy? | anyone calls `executeSweep` directly and forges `arg0` |
| `onlyCallbackSender` | is `arg0` our `SapuRSC`? | any reactive contract drives this forwarder through the real proxy |

**Verified:** `test_executeSweep_revertsWhenCallerIsNotProxy` (attacker calls directly and injects
the real RSC address, defeating guard 2 — guard 1 still rejects it) and
`test_executeSweep_revertsWhenCallbackSenderIsWrong` (through the genuine proxy, claiming a
different RSC — guard 2 rejects it with `CallbackNotAuthorized`). The end-to-end version is
`test_executeSweep_rejectsCallbackFromForeignRSC`: a second `SapuRSC` is deployed, armed against
the same burner pointing at the attacker, driven through the **genuine** proxy, and the forwarder
rejects it — `assertEq(token.balanceOf(attacker), 0, "attacker received nothing")`.

### Defence in depth beyond the protocol

The protocol guarantees the call came from the RSC you authorized. It does not guarantee the RSC is
still saying what you think. So the forwarder keeps its own `(token, burner) → coldWallet` registry
and re-checks the destination:

```solidity
if (!rule.armed) revert RouteNotArmed(burner_, token_);
if (rule.coldWallet != coldWallet_) revert DestinationMismatch(rule.coldWallet, coldWallet_);
```

A compromised or upgraded RSC therefore cannot redirect a sweep to an attacker's address. This is
SAPU's addition; the docs describe authentication, not this second registry.

**Verified:** `test_executeSweep_revertsOnDestinationMismatch`.

---

## 11. A contract cannot be both

> **Official:** "A contract can't be both reactive and callback. `AbstractPayer` holds a single
> immutable `_SERVICE_PROVIDER`, and `AbstractReactive` hardcodes it to `SYSTEM` while
> `AbstractCallback` sets it to the proxy, so inheriting both gives the same base constructor
> arguments twice and won't compile."

This single sentence dictates SAPU's entire topology: two contracts, two chains, and a deployment
order that breaks the address cycle. It is also why the repository has exactly two deployed
contracts and not one.

---

## 12. Deployment order

> **Official:** "Your callback contract needs the reactive contract's address at construction, and
> the reactive contract needs yours before it can name a recipient. Since `_CALLBACK_SENDER` is
> immutable, the cycle has to break on the reactive side: Deploy the reactive contract. Deploy the
> callback contract, passing the callback proxy address and the reactive contract's address. Set the
> recipient on the reactive contract through an owner-only setter. Fund both."

SAPU follows this exactly:

| Step | Official step | SAPU code |
| --- | --- | --- |
| 1 | deploy reactive | `contracts/script/DeployReactiveOmni.s.sol` → `SapuRSC` on Lasna |
| 2 | deploy callback with RSC address + proxy | `contracts/script/DeployDestination.s.sol` → `SapuForwarder` on Base Sepolia |
| 3 | set the recipient via an owner-only setter | `SapuRSC.setForwarder(address)` |
| 4 | fund both | `scripts/fund-rsc.sh`, plus ETH sent to the forwarder |

> **Official:** "Getting `callbackSender_` wrong is unrecoverable. There's no setter, so a mismatched
> address means redeploying."

`SapuForwarder` deliberately has no `setCallbackSender`. The app surfaces a mismatch as
`_CALLBACK_SENDER` drift in `docs/LIMITATIONS.md` §4 rather than offering a repair that cannot exist.

**Verified:** the owner gate on `setForwarder` is `onlyOwner` in the source, but there is no
dedicated test for it — `test_setForwarder_updatesAndEmits` and `test_setForwarder_revertsOnZero`
cover the behaviour, not the authorization. The neighbouring `onlyOwner` gates that *are* tested are
`test_registerRoute_revertsWhenNotOwner`, `test_revokeRoute_revertsWhenNotOwner`, and
`test_pause_revertsWhenNotOwner`. The resumable four-step pipeline in
`app/src/application/registration-service.ts` mirrors this order and can resume from on-chain state.

---

## 13. Payment: two ledgers, two currencies

> **Official:** "On Reactive, the system contract charges reactive contracts for executing `react()`.
> On a destination chain, the callback proxy charges callback contracts for delivering callbacks.
> Both inherit the same accounting logic … Contracts must stay funded on both sides to remain
> active."

> **Official:** "Callback contracts are funded in the destination chain's native token, ETH on
> Ethereum, BNB on BNB Chain, and so on, not in REACT."

| Component | Charged by | Currency | SAPU surface |
| --- | --- | --- | --- |
| `SapuRSC` | system contract `0x8888…8888` | REACT / lREACT | `/app/budget` — `debt()`, balance, `coverDebt` |
| `SapuForwarder` | Base Sepolia callback proxy | ETH | `/app/budget` — `debt()`, balance, `coverDebt` |
| Burner | nobody | — | never funded |

> **Official:** "Three separate numbers govern whether a contract can execute."

| Value | Held by | Meaning |
| --- | --- | --- |
| Balance | the contract itself | funds the contract can spend |
| Reserves | system contract or callback proxy | pre-paid credit for fees |
| Debt | system contract or callback proxy | fees owed but not yet paid |

SAPU reads **balance** and **debt** per side, and does not read reserves: `AbstractPayer` exposes no
public reserves getter, and the app will not invent one. What it does instead is refuse to collapse
what it does have into "funded / not funded" — a non-zero debt blocks execution immediately, while
an empty balance only matters at the moment of the next charge, so `/app/budget` reports them
separately and treats an unreadable debt as unknown rather than as zero.

**Verified:** `app/src/infrastructure/budget-reader.ts` reads `rscBalance`, `forwarderBalance`,
`rscDebt`, `forwarderDebt`; `readDebt` in `app/src/infrastructure/chain-reads.ts` returns `null` on
transport failure, and `app/src/domain/budget.ts` returns `sweepsRemaining: null` rather than `0`
when the per-sweep cost is zero.

---

## 14. Payment: debt blocks everything

> **Official:** "Execution stops whenever debt is greater than zero, not merely when a contract is
> underfunded. The system contract won't call `react()` and the callback proxy won't deliver a
> callback while any amount remains outstanding."

This is why SAPU treats debt as a first-class state rather than a warning:

- `SapuRSC.unpause()` calls `_coverDebt()` before resubscribing.
- `coverDebt()` is exposed **permissionlessly** on both contracts. The docs sanction exactly this:
  "Leaving it open to any caller lets a third party fund the contract and restart it, which is
  useful for contracts serving other people."
- `/app/budget` reads `debt()` per side and reports an unreadable debt as unknown, never as zero —
  because "no debt" is the one state that reads as healthy.
- The ledger's `strand-cause` distinguishes "route disarmed" from "preconditions unread", because a
  failed read is not evidence of a problem.

**Verified:** `test_coverDebt_settlesOutstandingDebt` on both suites;
`app/src/domain/__tests__/budget-warning.test.ts` — "reports an unread debt as unknown, never as
healthy", "does not confuse an unknown runway with an exhausted one".

---

## 15. Gas limits

> **Official:** "The maximum gas limit for reactive transactions is 900,000 units."

SAPU's `react()` is far below this: it decodes one log, reads two storage slots, and requests one
callback.

> **Official:** "Reactive Network enforces a minimum callback gas limit of 100,000 gas. Callback
> requests below this threshold are ignored, as this minimum ensures sufficient gas for internal
> audits and computations required to process the callback."

"ignored" is the dangerous word — no revert, no event, no sweep. SAPU therefore enforces the floor
on-chain instead of discovering it as a missing sweep:

```solidity
uint64 public constant MIN_CALLBACK_GAS_LIMIT = 100_000;

function setCallbackGasLimit(uint64 gasLimit_) external onlyOwner {
    if (gasLimit_ < MIN_CALLBACK_GAS_LIMIT) revert GasLimitTooLow(gasLimit_, MIN_CALLBACK_GAS_LIMIT);
    callbackGasLimit = gasLimit_;
}
```

> **Official:** "Before invoking a callback recipient, the callback proxy sets aside gas for its own
> accounting once the call returns (`_extraGas`) and for settling payment if the contract owes
> anything (`_maxChargeGas`). Only the remainder is forwarded … Delivery fails with `InsufficientGas`
> if too little is left to cover them."

Two distinct failure shapes, which SAPU documents separately because the fixes differ:

| Shape | Symptom | Fix |
| --- | --- | --- |
| limit below proxy overhead | `InsufficientGas`, method never runs | raise `callbackGasLimit` on the RSC |
| limit covers overhead but not the method | method reverts, `CallbackFailure` | raise `callbackGasLimit` on the RSC |

Neither is fixed by adding funds. `setCallbackGasLimit` exists for exactly this.

**Verified:** `test_setCallbackGasLimit_revertsBelowReactiveFloor` (asserts the revert carries
`99_999` against a floor of `100_000`) and `test_setCallbackGasLimit_acceptsExactlyTheFloor`.
`test_react_emitsCallbackForRegisteredBurner` asserts `gasLimit == 150_000`.

---

## 16. Failed execution is still charged

> **Official:** "A reverting `react()` is caught, logged as a `ReactiveContractReverted` event, and
> charged in full. A failing callback is logged as a `CallbackFailure` event and charged in full.
> Neither is refunded … The sole exception is a callback addressed to an account holding no code,
> which is rejected before any charge applies."

This is a real cost, not a footnote, and SAPU treats it as one:

- `docs/LIMITATIONS.md` §4 lists "Failed callbacks still cost money" as a failure mode.
- `/app/budget` reports the per-sweep cost so the operator can see how many failures the budget
  absorbs.
- `docs/DECISIONS.md` records that a token-supplied reentrancy path is guarded with
  `nonReentrant` partly because a reverted callback is *paid for* — an exploitable revert is a
  griefing vector, not just a bug.

---

## 17. Origins and destinations

> **Official:** "Origin: the chain where events happen and event logs are read from (the event
> source). Destination: the chain where Reactive Network delivers a callback transaction (the chain
> where state changes occur). Origins and destinations don't have to be the same."

SAPU sets origin **and** destination to the same chain — Base Sepolia — because the tokens land
there and must be swept there. The reactive contract sits on Lasna, which is neither: it is the
chain where the logic runs.

> **Official:** "Mainnets and testnets must not be mixed: if the origin is a mainnet, the
> destination must also be a mainnet."

The app refuses a mixed pair rather than falling back to a default:
`readDeploymentConfig()` reports a configuration error, and
`ReactiveChains.isMainnet()` makes the deploy scripts refuse the same mistake.

> **Official:** "Callbacks are delivered by Reactive Signer, which posts transactions to destination
> chains. These transactions pass through a callback proxy contract."

The callback proxy is **per chain**, and it is transcribed, not derived:

```solidity
// contracts/script/ReactiveChains.sol
function callbackProxy(uint256 chainId) internal pure returns (address) {
    if (chainId == BASE_SEPOLIA) return 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    // ...
    revert UnsupportedChain(chainId);   // an unlisted chain fails loudly
}
```

An unrecognised chain reverts instead of receiving a made-up proxy, because a wrong proxy makes
`onlyServiceProvider` reject every real callback with no on-chain signal explaining why.

**Verified:** `contracts/test/ReactiveChains.t.sol` pins all 13 rows — one `assertEq` per chain id
against the published proxy — and `test_callbackProxy_revertsForUnsupportedChain` pins the loud
failure. On the app side, `app/src/domain/__tests__/chains.test.ts` pins the same table ("carries
every official mainnet chain with its published callback proxy", "contains no chain beyond the
official list"). Note the two tables are *not* compared to each other by an automated gate: the
audit checks `app/src/config/chains.ts` against `scripts/lib/explorers.ts`, which is a different
concern. The Solidity↔TypeScript agreement is maintained by transcription and by these tests, not
by a cross-check.

---

## 18. Legacy versus Omni, stated

The docs describe a migration, and it is worth being explicit about which side SAPU is on:

| Legacy | Omni (current) | SAPU |
| --- | --- | --- |
| `react(LogRecord) external vmOnly` | `react(LogRecord) external onlySystem` | `onlySystem` |
| `if (!vm) { subscribe(...) }` | `SYSTEM.subscribe(...)` unconditionally | unconditional |
| `emit Callback(...)` | `SYSTEM.requestCallbackV_1_0(...)` | `requestCallbackV_1_0` |
| `0x0000000000000000000000000000000000fffFfF` | `0x8888888888888888888888888888888888888888` | `0x8888…8888` |
| RVM execution traces, custom RPC methods | plain EVM, `cast` works directly | plain `cast` / viem |

There is no `vm` modifier and no RVM anywhere in this repository. `SapuRSC` is an ordinary contract
that receives ordinary transactions from `SYSTEM`, which is why it can be inspected with
`cast` and read with viem like any other contract.

---

## 19. What SAPU adds beyond the protocol

Everything above is protocol compliance. Four things are SAPU's own design, and each is marked as
such so it is not mistaken for a Reactive requirement:

| Addition | Why | Risk if wrong |
| --- | --- | --- |
| `AbstractPausableReactiveContract` | pause must physically unsubscribe; criteria must be replayable | a subscription that is never removed bills forever |
| Forwarder-side rule registry | defence in depth against a compromised RSC | an extra state to keep in sync with the RSC's routes |
| `minDeposit` + `DustIgnored` | a callback costs more than a 1-wei deposit moves | the owner can raise the floor; every skip is observable |
| `rescueSweep` | `executeSweep` moves `min(amount, balance)`, so a failed callback strands that deposit permanently | owner-only, destination read from storage, so it cannot redirect funds |

---

## 20. Test map

| Official rule | Test |
| --- | --- |
| `react()` rejects non-system callers | `test_react_revertsWhenNotSystem` |
| exact six-criteria subscription | `test_registerRoute_subscribesWithExactCriteria` |
| `unsubscribe` replays criteria verbatim | `test_unpause_resubscribesSameCriteria` |
| duplicate criteria are deduplicated | `test_addSubscription_isIdempotentForIdenticalCriteria` |
| pause actually unsubscribes | `test_pause_unsubscribesEverything` |
| unpause settles debt first | *not pinned* — order visible in `unpause()`, see §7 |
| unmatched logs fall through | `test_react_ignoresWrongTopic0`, `test_react_ignoresOtherToken` |
| `opCode` gates decoding | `test_react_ignoresNonLog3Encoding` |
| payload reserves `address` in position 0 | `test_react_emitsCallbackForRegisteredBurner` |
| callback gas floor enforced | `test_setCallbackGasLimit_revertsBelowReactiveFloor` |
| both callback guards applied | `test_executeSweep_revertsWhenCallerIsNotProxy`, `test_executeSweep_revertsWhenCallbackSenderIsWrong` |
| foreign RSC cannot drive the forwarder | `test_executeSweep_rejectsCallbackFromForeignRSC` |
| destination re-check | `test_executeSweep_revertsOnDestinationMismatch` |
| burner never needs gas | `test_executeSweep_burnerNeverNeedsGas` |
| mainnet/testnet pair refused | `test_isMainnet_separatesTheTwoNetworks`, `chains.test.ts` |
| callback proxy table matches the docs | `test_callbackProxy_matchesOfficialTable` (13 rows) |

Run them with `npm test` (99 Foundry + 400 Vitest) or `forge test --root contracts`.
