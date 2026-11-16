// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractPausableReactiveContract } from "../base/AbstractPausableReactiveContract.sol";
import { IReactive } from "@reactive/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/interfaces/ISystemContract.sol";

/**
 * @title SapuRSC
 * @notice Silent Automated Purge Unit — reactive watcher.
 *
 *         Watches ERC-20 `Transfer` logs on Base Sepolia where topic_2 (the `to`
 *         field) equals a registered burner address. The instant a deposit lands,
 *         it asks Reactive Network to post a callback to `SapuForwarder` on Base
 *         Sepolia, which sweeps the tokens to the user's cold wallet.
 *
 * @dev ## Subscription shape
 *
 *      ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`
 *      has three topics, so a deposit arrives as `opCode == 3` with:
 *
 *        topic0 = keccak256("Transfer(address,address,uint256)")
 *               = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 *        topic1 = from  (left-padded)
 *        topic2 = to    (left-padded)  <-- the burner
 *        data   = abi.encode(uint256 value)
 *
 *      One subscription is created per (token, burner) pair:
 *
 *        SYSTEM.subscribe(
 *            BASE_SEPOLIA_CHAIN_ID,
 *            token,
 *            TRANSFER_TOPIC_0,
 *            REACTIVE_IGNORE,                     // any sender
 *            bytes32(uint256(uint160(burner))),   // only deposits *to* the burner
 *            REACTIVE_IGNORE
 *        )
 *
 *      `topic3` is left as the wildcard. `subscribe` takes six `uint256` criteria;
 *      passing `bytes32(uint256(uint160(addr)))` narrows to that exact left-padded
 *      address, which is precisely how an indexed `address` appears in a topic.
 *
 * @dev ## Why the payload starts with `address(0)`
 *
 *      Reactive Network overwrites the first 160 bits of every callback payload
 *      with the requesting reactive contract's address. The destination function
 *      must therefore declare `address` as its first parameter so the injected
 *      value lands in a real argument that `SapuForwarder` can authenticate.
 *
 * @dev ## Callback mechanism
 *
 *      The brief describes `emit Callback(...)`. That event still exists in
 *      `IReactive` but is marked deprecated, and the current dev.reactive.network
 *      standard routes callbacks through the system contract. `SapuRSC` therefore
 *      uses `SYSTEM.requestCallbackV_1_0(...)`, which the live Lasna system
 *      contract implements (verified on-chain — see docs/SPEC-REACTIVE-LOOP.md).
 *      The emitted `CallbackRequest` event from the system contract is the Tx2
 *      proof artefact.
 */
contract SapuRSC is AbstractPausableReactiveContract {
    /// @notice keccak256("Transfer(address,address,uint256)")
    uint256 public constant TRANSFER_TOPIC_0 =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;

    /// @notice Origin/destination chain id (Base Sepolia). Immutable: a SAPU instance is chain-scoped.
    uint256 public immutable CHAIN_ID;

    /// @notice Destination contract that performs the sweep. Set once, after deployment.
    address public sapuForwarder;

    /// @notice Default gas limit requested for the destination callback.
    /// @dev 150_000 per spec. Exposed via `setCallbackGasLimit` because the callback
    ///      proxy withholds gas for its own accounting, so a tight limit can surface
    ///      as `CallbackFailure` rather than a revert. See docs/LIMITATIONS.md.
    uint64 public callbackGasLimit = 150_000;

    /// @notice One armed sweep route.
    /// @param coldWallet Destination that receives the swept tokens.
    /// @param active Whether the route is armed. Disarmed routes are ignored by `react()`.
    /// @param registeredBlock Block at which the route was armed (forensics only).
    struct Route {
        address coldWallet;
        bool active;
        uint64 registeredBlock;
    }

    /// @dev token => burner => route. Keyed the same way `react()` looks up.
    mapping(address => mapping(address => Route)) private _routes;

    /// @dev burner => list of tokens, so a burner can be fully disarmed.
    mapping(address => address[]) private _burnerTokens;

    /// @notice Emitted when a route is armed.
    event RouteRegistered(
        address indexed burner, address indexed coldWallet, address indexed token, uint64 gasLimit
    );

    /// @notice Emitted when a route is disarmed.
    event RouteRevoked(address indexed burner, address indexed token);

    /// @notice Emitted when the forwarder destination is set.
    event ForwarderSet(address indexed forwarder);

    /// @notice Emitted when the callback gas limit changes.
    event CallbackGasLimitSet(uint64 gasLimit);

    /// @notice Emitted on every accepted deposit, before the callback request.
    event PurgeTriggered(
        address indexed burner,
        address indexed token,
        address indexed coldWallet,
        uint256 amount,
        uint256 originBlockNumber
    );

    /// @notice Reverts when a route is already armed for the (token, burner) pair.
    error RouteAlreadyRegistered(address burner, address token);

    /// @notice Reverts when no active route exists for the (token, burner) pair.
    error RouteNotRegistered(address burner, address token);

    /// @notice Reverts when the forwarder has not been set yet.
    error ForwarderNotSet();

    /// @notice Reverts when an argument that must be non-zero is zero.
    error InvalidArgument();

    /// @param initialOwner_ Operator allowed to arm routes and pause.
    /// @param chainId_ Base Sepolia chain id (84532).
    constructor(address initialOwner_, uint256 chainId_) payable AbstractPausableReactiveContract(initialOwner_) {
        if (chainId_ == 0) revert InvalidArgument();
        CHAIN_ID = chainId_;
    }

    // -------------------------------------------------------------------------
    // Operator surface
    // -------------------------------------------------------------------------

    /// @notice Arms a sweep route and subscribes to deposits into `burner_`.
    /// @dev Owner-gated on purpose. A permissionless `registerRoute` would let an
    ///      attacker point someone else's burner at the attacker's cold wallet and
    ///      harvest every deposit. See docs/LIMITATIONS.md.
    /// @param burner_ Burner/stealth address to watch. Must be non-zero.
    /// @param coldWallet_ Destination for swept funds. Must be non-zero.
    /// @param token_ ERC-20 to watch. Must be non-zero.
    function registerRoute(address burner_, address coldWallet_, address token_) external onlyOwner {
        if (burner_ == address(0) || coldWallet_ == address(0) || token_ == address(0)) {
            revert InvalidArgument();
        }

        Route storage route = _routes[token_][burner_];
        if (route.active) revert RouteAlreadyRegistered(burner_, token_);

        route.coldWallet = coldWallet_;
        route.active = true;
        // Block numbers cannot realistically exceed uint64, but truncating silently
        // would corrupt the forensic record, so it is checked rather than cast blindly.
        if (block.number > type(uint64).max) revert InvalidArgument();
        // forge-lint: disable-next-line(unsafe-typecast)
        route.registeredBlock = uint64(block.number);
        _burnerTokens[burner_].push(token_);

        _addSubscription(
            Subscription({
                chainId: CHAIN_ID,
                contractAddress: token_,
                topic0: TRANSFER_TOPIC_0,
                topic1: REACTIVE_IGNORE,
                topic2: uint256(uint160(burner_)),
                topic3: REACTIVE_IGNORE
            })
        );

        // Emitted after the external `subscribe` call; the ordering is intentional so
        // the log reflects the route only once the node has accepted it.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RouteRegistered(burner_, coldWallet_, token_, callbackGasLimit);
    }

    /// @notice Disarms a route and withdraws its subscription.
    function revokeRoute(address burner_, address token_) external onlyOwner {
        Route storage route = _routes[token_][burner_];
        if (!route.active) revert RouteNotRegistered(burner_, token_);

        route.active = false;
        delete route.coldWallet;

        _removeSubscription(
            Subscription({
                chainId: CHAIN_ID,
                contractAddress: token_,
                topic0: TRANSFER_TOPIC_0,
                topic1: REACTIVE_IGNORE,
                topic2: uint256(uint160(burner_)),
                topic3: REACTIVE_IGNORE
            })
        );

        emit RouteRevoked(burner_, token_);
    }

    /// @notice Sets the destination contract. One-time in practice; owner can correct a mistake.
    /// @dev Deployment order is forced: this contract must exist before `SapuForwarder`
    ///      (which immutably stores this address as its authorized callback sender),
    ///      so the forwarder address can only be supplied afterwards.
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert InvalidArgument();
        sapuForwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    /// @notice Adjusts the requested callback gas limit.
    /// @dev Raising this is the fix when the forwarder emits `CallbackFailure` because
    ///      the proxy withheld too much of the requested gas for its own accounting.
    function setCallbackGasLimit(uint64 gasLimit_) external onlyOwner {
        if (gasLimit_ == 0) revert InvalidArgument();
        callbackGasLimit = gasLimit_;
        emit CallbackGasLimitSet(gasLimit_);
    }

    // -------------------------------------------------------------------------
    // Reactive entry point
    // -------------------------------------------------------------------------

    /// @inheritdoc IReactive
    /// @dev Runs as a normal Reactive Network transaction paid from this contract's
    ///      REACT balance. Unmatched logs fall through cheaply instead of reverting:
    ///      a revert is caught by the system contract, emits
    ///      `ReactiveContractReverted`, and is still billed.
    function react(LogRecord memory log_) external onlySystem whenNotPaused {
        // Route on topic0 first: several subscriptions share this entry point.
        if (log_.topic0 != TRANSFER_TOPIC_0) return;

        // `opCode` is the authoritative topic count. An ERC-20 Transfer is a LOG3.
        // A LOG1 encoding (unindexed params) would put everything in `data`, so a
        // zero topic position is not sufficient evidence of a missing topic.
        if (log_.opCode != 3) return;

        address token = log_.contractAddress;
        // topic2 is the indexed `to` address, left-padded into a uint256. Taking the
        // low 160 bits is exact here: the node normalises an indexed `address` into
        // this shape, so no meaningful bits exist above bit 159.
        // forge-lint: disable-next-line(unsafe-typecast)
        address burner = address(uint160(log_.topic2));

        Route storage route = _routes[token][burner];
        if (!route.active) return;

        address forwarder = sapuForwarder;
        if (forwarder == address(0)) revert ForwarderNotSet();

        // `data` holds only the non-indexed parameter(s): the amount.
        uint256 amount = abi.decode(log_.data, (uint256));
        if (amount == 0) return;

        emit PurgeTriggered(burner, token, route.coldWallet, amount, log_.blockNumber);

        // The leading `address(0)` is the slot the callback proxy overwrites with
        // this contract's address. Without it the forwarder cannot authenticate us.
        bytes memory payload = abi.encodeWithSignature(
            "executeSweep(address,address,address,address,uint256)",
            address(0),
            token,
            burner,
            route.coldWallet,
            amount
        );

        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: CHAIN_ID,
                recipient: forwarder,
                gasLimit: callbackGasLimit,
                payload: payload
            })
        );
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the armed route for a (token, burner) pair.
    function routeOf(address token_, address burner_) external view returns (Route memory) {
        return _routes[token_][burner_];
    }

    /// @notice Returns every token registered against a burner.
    function tokensOf(address burner_) external view returns (address[] memory) {
        return _burnerTokens[burner_];
    }
}
