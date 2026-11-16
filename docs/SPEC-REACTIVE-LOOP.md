# SPEC — The Reactive Loop

Exact hashes, criteria, gas budgets, and the proof methodology for SAPU's three-transaction
loop. Everything in this document is either a protocol constant (verifiable against
`dev.reactive.network`) or a value defined in SAPU's own contracts.

---

## 1. Chain roles

| Role | Chain | Chain ID | RPC |
| --- | --- | --- | --- |
| Origin (events read) | Base Sepolia | `84532` | `https://sepolia.base.org` |
| Reactive (logic runs) | Reactive Lasna | `5318007` | `https://lasna-rpc.rnk.dev/` |
| Destination (callbacks delivered) | Base Sepolia | `84532` | `https://sepolia.base.org` |

Origin and destination are the same chain here — SAPU sweeps on the chain the funds landed
on. The reactive contract lives on Lasna. Testnets are never mixed with mainnets.

### Protocol addresses

| Contract | Address |
| --- | --- |
| Reactive system contract (Lasna **and** Mainnet) | `0x8888888888888888888888888888888888888888` |
| Base Sepolia callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |
| Base Sepolia lREACT faucet | `0x2afaFD298b23b62760711756088F75B7409f5967` |

> Verified on-chain: the Lasna proxy at `0x8888…8888` delegates to implementation
> `0xbbbb…bbbb`, whose runtime bytecode contains the selectors for `subscribe`
> (`0x5a6aced0`), `unsubscribe`, `requestCallbackV_1_0` (`0x6407b0c1`),
> `requestCallback` (`0x734aae8c`), and `debt` (`0x9b6c56ec`). This is what justifies
> using the Omni callback API rather than the deprecated `Callback` event.

---

## 2. Origin event

SAPU consumes a standard ERC-20 `Transfer`. No custom event, no wrapper contract.

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
```

| Field | Value |
| --- | --- |
| `topic0` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `topic1` | `from`, left-padded to 32 bytes |
| `topic2` | `to`, left-padded to 32 bytes ← **the burner** |
| `topic3` | absent |
| `data` | `abi.encode(uint256 value)` |
| `opCode` | `3` (`LOG3`) |

`topic0` is `keccak256("Transfer(address,address,uint256)")`. A test asserts this constant
against `encodeEventTopics` from `viem`, so a typo cannot survive CI.

### Why `opCode` matters

`react()` checks `log_.opCode == 3` before decoding. `LogRecord` always carries four topic
fields, with unused positions zeroed — but **a zero topic is not evidence of a missing
topic**, because `address(0)` is a legitimate value (an ERC-20 mint has `from == address(0)`).
`opCode` is the authoritative topic count. A `LOG1`-encoded Transfer would pack everything
into `data`; decoding it as if `topic2` held the recipient would attribute the deposit to
the wrong burner.

---

## 3. Subscription criteria

One subscription per `(token, burner)` pair, created by `SapuRSC.registerRoute`.

```solidity
SYSTEM.subscribe(
    84532,                                   // chainId_        : Base Sepolia
    token,                                   // contract_       : the ERC-20
    0xddf252ad...b3ef,                       // topic0_         : Transfer
    REACTIVE_IGNORE,                         // topic1_         : any sender
    uint256(uint160(burner)),                // topic2_         : only TO the burner
    REACTIVE_IGNORE                          // topic3_         : unused
);
```

`REACTIVE_IGNORE` is `0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad`,
supplied by `AbstractReactive`.

### Subscription semantics that shape the design

| Property | Consequence for SAPU |
| --- | --- |
| Equality only — no ranges or bitwise filters | `topic2` must be the exact padded burner; a range of burners cannot share one subscription |
| One criteria set per subscription; no `OR` | N burners ⇒ N subscriptions ⇒ N `subscribe()` calls |
| Duplicates are allowed but pointless, and cost gas | `_addSubscription` deduplicates by criteria hash before calling the node |
| Subscriptions live in the node, not in storage | `SapuRSC` keeps its own registry; it cannot read the node's |
| `unsubscribe` requires an **exact** six-argument match | Criteria are stored once and replayed verbatim by both `_subscribe` and `_unsubscribe` |
| At least one criterion must be specific | `chainId`, `token`, and `topic0` are all specific |

The exact-match rule is the sharpest edge: any drift between the subscribe and unsubscribe
calls leaves the subscription live **forever**, silently. This is why
`AbstractPausableReactiveContract` funnels both calls through a single `Subscription` struct.

---

## 4. Reactive logic

```solidity
function react(LogRecord memory log_) external onlySystem whenNotPaused {
    if (log_.topic0 != TRANSFER_TOPIC_0) return;
    if (log_.opCode != 3) return;

    address token  = log_.contractAddress;
    address burner = address(uint160(log_.topic2));

    Route storage route = _routes[token][burner];
    if (!route.active) return;

    uint256 amount = abi.decode(log_.data, (uint256));
    if (amount == 0) return;

    // ... request callback
}
```

Unmatched logs **fall through** rather than reverting. A revert is caught by the system
contract, emits `ReactiveContractReverted`, and is still billed — so reverting as a filter
is a pure loss.

`react()` is guarded by `onlySystem`, which checks `msg.sender == SYSTEM`
(`0x8888…8888`). Without it, anyone could hand the contract a fabricated log record.

---

## 5. Callback

### Mechanism

The brief describes `emit Callback(chainId, forwarder, gasLimit, payload)`. That event still
exists in `IReactive` but is explicitly **deprecated** in the current library:

> `/// @dev Deprecated and should not be used for new development. Use the system contract's
> requestCallback() and requestCallback_V_*_*() methods.`

SAPU therefore uses the current standard, which the live Lasna system contract implements:

```solidity
SYSTEM.requestCallbackV_1_0(
    ISystemContract.CallbackConfiguration_V_1_0({
        chainId:  CHAIN_ID,        // 84532
        recipient: forwarder,      // SapuForwarder
        gasLimit: 150_000,         // spec value, adjustable by the owner
        payload:  payload
    })
);
```

This causes the system contract to emit `CallbackRequest`, which is SAPU's **Tx2 proof**.

### Payload — the address slot

```solidity
bytes memory payload = abi.encodeWithSignature(
    "executeSweep(address,address,address,address,uint256)",
    address(0),      // ← reserved: overwritten by the proxy with SapuRSC's address
    token,
    burner,
    coldWallet,
    amount
);
```

Reactive Network replaces the **first 160 bits of the payload** with the requesting reactive
contract's address. The destination function must declare `address` first, and the caller
must pass a placeholder. Omitting it is the single most common way to break a callback.

A test double reproduces this byte-for-byte (`CallbackProxySimulator.deliver`), overwriting
bytes `[16..35]` of the payload — selector untouched, `arg0` replaced. An earlier draft of
that simulator wrote at the wrong offset, which made the forwarder's authentication pass for
the wrong reason; the byte-indexed loop replaced it.

### Authentication

`SapuForwarder.executeSweep` applies **both** guards:

```solidity
function executeSweep(
    address reactiveSender_,
    address token_,
    address burner_,
    address coldWallet_,
    uint256 amount_
) external onlyServiceProvider onlyCallbackSender(reactiveSender_) { ... }
```

| Guard | Question | Failure if omitted |
| --- | --- | --- |
| `onlyServiceProvider` | Is `msg.sender` the callback proxy? | Anyone calls `executeSweep` directly and forges `arg0` |
| `onlyCallbackSender` | Is `arg0` our authorized RSC? | Any reactive contract drives this forwarder via the real proxy |

---

## 6. Gas requirements

Three independent budgets. A contract in debt receives **nothing**, so an unfunded component
fails silently rather than loudly.

| Component | Pays for | Currency | Notes |
| --- | --- | --- | --- |
| `SapuRSC` | Every reactive transaction | lREACT (Lasna) | `constructor` is `payable`; fund at deploy |
| `SapuForwarder` | Callback execution | ETH (Base Sepolia) | Billed by the proxy, **not** by the RSC |
| Burner | Nothing | — | Holds zero ETH for its entire life |

### Callback gas limit

`150_000` per spec. Two failure shapes exist and they are not the same:

- **Too low to cover proxy overhead** → `InsufficientGas` before the method runs.
- **Covers overhead but not the method** → the method reverts, surfacing as `CallbackFailure`.

Both are set on the reactive side, so the fix is raising `callbackGasLimit` on `SapuRSC`,
not adding funds. `setCallbackGasLimit` exists for exactly this.

A **failed callback still costs the forwarder gas**. Repeated failures drain it.

### Debt settlement

`coverDebt()` is exposed on both contracts and is **permissionless** on purpose: anyone may
push a contract back into good standing. `unpause()` calls `_coverDebt()` before resubscribing,
because a contract in debt receives no events.

---

## 7. Deployment order

`SapuForwarder` immutably stores the RSC address as `_CALLBACK_SENDER`, and `SapuRSC` needs
the forwarder address to name a callback recipient. The cycle breaks on the reactive side:

1. Deploy `SapuRSC` on Lasna (fund with lREACT).
2. Deploy `SapuForwarder` on Base Sepolia, passing the RSC address and the callback proxy.
3. `SapuRSC.setForwarder(forwarder)`.
4. `SapuRSC.registerRoute(burner, coldWallet, token)`.
5. `SapuForwarder.armRoute(token, burner, coldWallet)`.
6. Fund `SapuForwarder` with ETH for callbacks.

Step 5 is not optional. Without it, the callback fires and reverts with `RouteNotArmed`.
Steps 4 and 5 are both required; either alone produces a loop that never completes.

Getting `_CALLBACK_SENDER` wrong is unrecoverable — there is no setter. A mismatch means
redeploying the forwarder.

---

## 8. Proof methodology

The loop is proven by three independently verifiable transactions.

| Leg | Chain | Contract | Event | Topic 0 |
| --- | --- | --- | --- | --- |
| **Tx1** deposit | Base Sepolia | the ERC-20 | `Transfer` | `0xddf252ad…b3ef` |
| **Tx2** reactive | Reactive Lasna | `0x8888…8888` | `CallbackRequest` | `0xef94dbc6…b133` |
| **Tx3** sweep | Base Sepolia | `SapuForwarder` | `TokensSwept` | `0x17699015…6454` |

### Tx2 — `CallbackRequest`

```solidity
event CallbackRequest(
    uint256 indexed chainId,
    address indexed sender,
    address indexed recipient,
    CallbackVersion version,
    bytes configuration
);
```

| Topic | Meaning | Expected value |
| --- | --- | --- |
| `topic1` | destination chain id | `84532` |
| `topic2` | requesting reactive contract | `SapuRSC` |
| `topic3` | recipient | `SapuForwarder` |

`topic3` is what `findCallbackRequests` filters on, so the watcher sees only callbacks aimed
at this deployment's forwarder.

### Tx3 — `TokensSwept`

```solidity
event TokensSwept(
    address indexed burner,
    address indexed token,
    address indexed coldWallet,
    uint256 amount,
    address reactiveSender
);
```

`reactiveSender` is the authenticated RSC address, carried through from the callback. It is
redundant with `_CALLBACK_SENDER` by construction — that redundancy is the point: the log
records *who* authorized the sweep, not just that one happened.

### Verification commands

```bash
# Tx1: did tokens reach the burner?
cast logs --address $TOKEN \
  --from-block $FROM --to-block latest \
  0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef \
  null 0x000000000000000000000000$BURNER \
  --rpc-url $BASE_SEPOLIA_RPC_URL

# Tx2: did the RSC fire?
cast logs --address 0x8888888888888888888888888888888888888888 \
  --from-block $FROM --to-block latest \
  0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133 \
  null null 0x000000000000000000000000$FORWARDER \
  --rpc-url $REACTIVE_RPC_URL

# Tx3: did the sweep complete?
cast logs --address $FORWARDER \
  --from-block $FROM --to-block latest \
  0x1769901594938d4b192c89308e322eb4bbea492c40a9086b66fa2a4959696454 \
  0x000000000000000000000000$BURNER \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

`scripts/verify-sweep.ts` automates all three and prints a PASS/FAIL table.

### What "verified" means here

A receipt is reported complete **only** when all three legs are observed on-chain. The domain
type makes this structural:

```ts
export function isComplete(receipt: SweepReceipt): receipt is ... {
  return receipt.reactive !== null && receipt.sweep !== null && receipt.sweptAmount !== null;
}
```

A receipt missing Tx3 reports `sweptAmount: null` and renders as "waiting" in the proof table.
No placeholder hash is ever fabricated to fill a gap.

---

## 9. Test coverage

`forge coverage` — **100%** lines, statements, branches, and functions across all of `src/`:

| File | Lines | Statements | Branches | Funcs |
| --- | --- | --- | --- | --- |
| `AbstractPausableReactiveContract.sol` | 100% | 100% | 100% | 100% |
| `SapuForwarder.sol` | 100% | 100% | 100% | 100% |
| `SapuRSC.sol` | 100% | 100% | 100% | 100% |
| `SweepableERC20.sol` | 100% | 100% | — | 100% |

76 Foundry tests, including fuzz tests over deposit amounts and arbitrary non-burner
recipients.

### On mocks

`test/mocks/MockSystemContract.sol` and `test/mocks/CallbackProxySimulator.sol` exist **only**
for `forge test`. Neither is deployed by any script, referenced by the app, or reachable from
the demo path. They are etched over the real addresses in tests via `vm.etch` so the production
bytecode under test talks to a stand-in that reproduces two specific protocol behaviours:
equality-only unsubscribe, and first-160-bit payload injection.

They are two contracts rather than one because the system contract (Lasna) and the callback
proxy (Base Sepolia) are genuinely different addresses. Conflating them would let the
forwarder's guards pass for the wrong reason.
