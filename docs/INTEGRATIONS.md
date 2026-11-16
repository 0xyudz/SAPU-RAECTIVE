# INTEGRATIONS

Every external system SAPU touches, with the exact values needed to reproduce the loop.

---

## Reactive Network

### Networks

| Network | Chain ID | RPC | Explorer | Currency |
| --- | --- | --- | --- | --- |
| Reactive Mainnet | `1597` | `https://mainnet-rpc.rnk.dev/` | `https://reactscan.net` | REACT |
| Reactive Lasna (testnet) | `5318007` | `https://lasna-rpc.rnk.dev/` | `https://lasna.reactscan.net` | lREACT |

SAPU targets **Lasna**. The system contract address is identical on both networks.

### System contract

```
0x8888888888888888888888888888888888888888
```

Interface used by SAPU (`ISystemContract` from `reactive-lib-omni`):

```solidity
function subscribe(uint256 chainId_, address contract_, uint256 topic0_,
                   uint256 topic1_, uint256 topic2_, uint256 topic3_) external;

function unsubscribe(uint256 chainId_, address contract_, uint256 topic0_,
                     uint256 topic1_, uint256 topic2_, uint256 topic3_) external;

struct CallbackConfiguration_V_1_0 {
    uint256 chainId;
    address recipient;
    uint64  gasLimit;
    bytes   payload;
}

function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external;

function debt(address contract_) external view returns (uint256);
```

**Verified on-chain (Lasna):** the proxy at `0x8888…8888` delegates to implementation
`0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` (30,294 bytes of runtime code), which contains
the dispatch selectors:

| Selector | Function |
| --- | --- |
| `0x5a6aced0` | `subscribe(uint256,address,uint256,uint256,uint256,uint256)` |
| `0x9b6c56ec` | `debt(address)` |
| `0x6407b0c1` | `requestCallbackV_1_0((uint256,address,uint64,bytes))` |
| `0x734aae8c` | `requestCallback(uint8,bytes)` |

An unknown selector reverts, confirming this is real dispatch and not a permissive fallback.

### Library

```
github.com/Reactive-Network/reactive-lib-omni
```

Cloned into `contracts/lib/reactive`. Imported via the remapping
`@reactive/=lib/reactive/src/`.

Base contracts used:

| Contract | Role |
| --- | --- |
| `AbstractReactive` | Provides `SYSTEM`, `REACTIVE_IGNORE`, `onlySystem`; brings `AbstractPayer` |
| `AbstractCallback` | Provides `_CALLBACK_SENDER`, `onlyCallbackSender`; sets `_SERVICE_PROVIDER` to the proxy |
| `AbstractPayer` | `pay()`, `_coverDebt()`, `receive()`, `onlyServiceProvider` |

A contract **cannot** be both reactive and callback: `AbstractPayer` holds a single immutable
`_SERVICE_PROVIDER`, and inheriting both passes the base constructor twice. SAPU splits them
across two chains and two contracts, which is the intended shape.

### lREACT faucet

Send Base Sepolia ETH to receive lREACT at **1 ETH → 100 lREACT**.

```
Base Sepolia faucet: 0x2afaFD298b23b62760711756088F75B7409f5967
```

```bash
cast send 0x2afaFD298b23b62760711756088F75B7409f5967 \
  "request(address)" $WALLET_ADDR \
  --value 0.1ether \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Limits: max 5 ETH per transaction, max 500 lREACT received. Amounts above 5 ETH are lost.

---

## Base Sepolia

| Property | Value |
| --- | --- |
| Chain ID | `84532` |
| RPC (public) | `https://sepolia.base.org` |
| Explorer | `https://sepolia.basescan.org` |
| Currency | ETH |
| Callback proxy | `0x476F44b11F5C942c58f4c8E3d0300E5710743585` |

### Callback proxy

The proxy is what bills `SapuForwarder` for callback execution, in ETH. It also performs the
first-160-bit payload injection that `onlyCallbackSender` relies on.

`sapuForwarder._SERVICE_PROVIDER` must equal this address. It is set at construction and is
immutable.

### Verification

Contracts can be verified through Sourcify, which needs no API key:

```bash
forge verify-contract \
  --verifier sourcify \
  --chain-id 5318007 \
  $SAPU_RSC_ADDRESS \
  src/reactive/SapuRSC.sol:SapuRSC
```

For Base Sepolia, use `--chain-id 84532`.

---

## EIP-2612 (permit)

SAPU depends on EIP-2612 to arm the sweep allowance **without the burner ever sending a
transaction**.

### Why

`SapuForwarder.executeSweep` pulls tokens with `transferFrom(burner, coldWallet, amount)`.
That requires an allowance. There are exactly two ways to grant one:

| Path | Burner sends a tx? | Needs gas in burner? | Preserves SAPU's promise? |
| --- | --- | --- | --- |
| `approve()` | Yes | **Yes** | **No** — funding the gas recreates the link |
| EIP-2612 `permit` | No | No | **Yes** |

The permit is signed off-chain (free), submitted by any relayer (the signature authorizes,
not the caller), and grants a standing allowance to the forwarder.

### Interface

```solidity
function permit(
    address owner,
    address spender,
    uint256 value,
    uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external;

function nonces(address owner) external view returns (uint256);
function DOMAIN_SEPARATOR() external view returns (bytes32);
```

`SapuForwarder.armWithPermit` consumes it:

```solidity
function armWithPermit(
    address token_, address burner_, uint256 value_, uint256 deadline_,
    uint8 v_, bytes32 r_, bytes32 s_
) external {
    IERC20Permit(token_).permit(burner_, address(this), value_, deadline_, v_, r_, s_);
    emit PermitArmed(token_, burner_, value_, deadline_);
}
```

Note the parameter order: `permit(owner, spender, ...)` where `owner` is the **burner** and
`spender` is the **forwarder**.

### Token support

Not every ERC-20 implements EIP-2612. `SweepableERC20` does (it extends OpenZeppelin's
`ERC20Permit`). For a token without permit support, the operator must fall back to
`approve()` and accept that the burner needs gas — see `LIMITATIONS.md`.

### Domain separator

```
keccak256(
  abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256(bytes(name)),
    keccak256(bytes("1")),
    chainId,
    tokenAddress
  )
)
```

Struct hash:

```
keccak256(
  abi.encode(
    keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
    owner, spender, value, nonce, deadline
  )
)
```

Digest: `keccak256("\x19\x01" || domainSeparator || structHash)`.

A test (`test_armWithPermit_grantsAllowanceAndEnablesSweep`) signs a real permit with
`vm.sign` and drives a full sweep through it.

---

## OpenZeppelin

`contracts/lib/openzeppelin-contracts` at tag `v5.4.0`.

| Module | Used by |
| --- | --- |
| `token/ERC20/ERC20.sol` | `SweepableERC20` |
| `token/ERC20/extensions/ERC20Permit.sol` | `SweepableERC20` (EIP-2612) |
| `token/ERC20/utils/SafeERC20.sol` | `SapuForwarder` (non-standard return values) |
| `access/Ownable.sol` | `SapuRSC`, `SapuForwarder` |

OZ 5.x `Ownable` rejects `address(0)` with `OwnableInvalidOwner` **before** SAPU's own
zero-address check is reached. Tests assert the actual error, not the intended one.

---

## viem

`viem@^2.57` in the app and scripts.

**API note:** viem 2.57 removed the raw `topics` parameter from `getLogs`. Filtering is done
with a typed `event` plus `args`:

```ts
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

await client.getLogs({
  address: token,
  event: transferEvent,
  args: { to: burner },   // constrains topic_2 — the same position the RSC subscribes on
  fromBlock,
  toBlock: "latest",
});
```

This is strictly better for SAPU: `args: { to: burner }` is the client-side expression of the
exact same criteria the reactive contract subscribes to, so the watcher and the RSC cannot
drift.

---

## Environment

See `.env.example` at the repository root. Nothing is required to build or test — every
chain-dependent path degrades gracefully to a clear "not configured" state.

| Variable | Chain | Required for live loop |
| --- | --- | --- |
| `REACTIVE_RPC_URL` | Lasna | yes |
| `REACTIVE_PRIVATE_KEY` | Lasna | yes (deploy) |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia | yes |
| `DEPLOYER_PRIVATE_KEY` | Base Sepolia | yes (deploy) |
| `SAPU_OWNER` | both | no (defaults to broadcaster) |
| `SAPU_RSC_ADDRESS` | — | yes (after step 1) |
| `SAPU_FORWARDER_ADDRESS` | — | yes (after step 2) |
| `SAPU_TOKEN_ADDRESS` | Base Sepolia | yes |
| `SAPU_COLD_WALLET` | — | yes (route registration) |
| `SAPU_BURNER_ADDRESS` | — | yes (route registration) |
