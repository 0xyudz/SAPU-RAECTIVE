// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "@reactive/base/AbstractReactive.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AbstractPausableReactiveContract
 * @notice Reactive Omni base that adds an operator kill-switch and a tracked
 *         subscription registry on top of `AbstractReactive`.
 *
 * @dev Why this exists rather than inheriting `AbstractReactive` directly:
 *
 *      1. **Pause semantics.** A reactive contract keeps paying for every matching
 *         log it receives. Subscriptions live in the node, not in contract storage,
 *         so "pause" must physically `unsubscribe` — merely setting a boolean would
 *         still burn gas on every event. `pause()` unsubscribes every tracked
 *         criteria set; `unpause()` resubscribes the same set.
 *
 *      2. **Exact-match bookkeeping.** `unsubscribe()` only removes a subscription
 *         whose six criteria match the original call exactly. Any drift silently
 *         leaves the subscription live forever, so the criteria are stored once and
 *         replayed verbatim by both `_subscribe` and `_unsubscribe`.
 *
 *      3. **Debt settlement.** A reactive contract in debt receives nothing. The
 *         docs recommend settling before resubscribing, which `unpause()` does.
 *
 * @custom:security The owner can pause and resubscribe, but can never change the
 *          criteria of an existing subscription — `_subscribe` always replays the
 *          stored `Subscription` struct, so a route cannot be silently retargeted.
 */
abstract contract AbstractPausableReactiveContract is AbstractReactive, Ownable {
    /// @notice One exact set of subscription criteria, replayable byte-for-byte.
    struct Subscription {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    /// @notice Emitted when a criteria set becomes active.
    event SubscriptionAdded(bytes32 indexed subscriptionId, Subscription subscription);

    /// @notice Emitted when a criteria set is removed.
    event SubscriptionRemoved(bytes32 indexed subscriptionId, Subscription subscription);

    /// @notice Emitted when the operator pauses or unpauses reactive processing.
    event Paused(address indexed operator);
    event Unpaused(address indexed operator);

    /// @notice Reverts when an action is attempted while paused.
    error ContractPaused();

    /// @notice Reverts when an action is attempted while not paused.
    error ContractNotPaused();

    /// @notice Reverts when a required address argument is the zero address.
    error ZeroAddress();

    /// @notice True while reactive processing is suspended.
    bool public paused;

    /// @dev criteria id => criteria. Replayed verbatim on resubscribe.
    mapping(bytes32 => Subscription) private _subscriptions;

    /// @dev criteria id => currently subscribed on the node.
    mapping(bytes32 => bool) private _subscriptionActive;

    /// @dev criteria id => ever registered. Prevents duplicate registration.
    mapping(bytes32 => bool) private _subscriptionKnown;

    /// @dev Iteration order for pause/unpause and `subscriptions()`.
    bytes32[] private _subscriptionIds;

    constructor(address initialOwner_) Ownable(initialOwner_) { }

    // -------------------------------------------------------------------------
    // Operator surface
    // -------------------------------------------------------------------------

    /// @notice Pauses reactive processing by unsubscribing every tracked criteria set.
    /// @dev Invariant: while unpaused, every id in `_subscriptionIds` is active. Ids
    ///      registered during a pause are appended inactive, and `unpause()` activates
    ///      them before the contract is considered unpaused again. State is flipped
    ///      before each external call so a reentrant path never sees a half-torn-down
    ///      registry.
    function pause() external onlyOwner {
        if (paused) revert ContractPaused();
        paused = true;

        uint256 length = _subscriptionIds.length;
        for (uint256 i = 0; i < length; ++i) {
            bytes32 id = _subscriptionIds[i];
            _subscriptionActive[id] = false;
            _unsubscribe(_subscriptions[id]);
            emit SubscriptionRemoved(id, _subscriptions[id]);
        }

        emit Paused(msg.sender);
    }

    /// @notice Resumes reactive processing, settling any outstanding debt first.
    /// @dev A contract in debt receives nothing, so debt is covered before the
    ///      node is asked to deliver again.
    function unpause() external onlyOwner {
        if (!paused) revert ContractNotPaused();
        paused = false;

        _coverDebt();

        uint256 length = _subscriptionIds.length;
        for (uint256 i = 0; i < length; ++i) {
            bytes32 id = _subscriptionIds[i];
            _subscriptionActive[id] = true;
            _subscribe(_subscriptions[id]);
            emit SubscriptionAdded(id, _subscriptions[id]);
        }

        emit Unpaused(msg.sender);
    }

    /// @notice Settles outstanding debt from this contract's own balance.
    /// @dev Permissionless: anyone may push the contract back into good standing.
    ///      `_coverDebt()` is internal in `AbstractPayer`, so it is exposed here.
    function coverDebt() external {
        _coverDebt();
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns every tracked criteria set, active or not.
    function subscriptions() external view returns (Subscription[] memory result_) {
        uint256 length = _subscriptionIds.length;
        result_ = new Subscription[](length);
        for (uint256 i = 0; i < length; ++i) {
            result_[i] = _subscriptions[_subscriptionIds[i]];
        }
    }

    /// @notice Number of criteria sets ever registered.
    function subscriptionCount() external view returns (uint256) {
        return _subscriptionIds.length;
    }

    /// @notice Whether the criteria set with the given id is currently live on the node.
    function isSubscriptionActive(bytes32 subscriptionId_) external view returns (bool) {
        return _subscriptionActive[subscriptionId_];
    }

    /// @notice Deterministic id for a criteria set.
    function subscriptionId(Subscription memory subscription_) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                subscription_.chainId,
                subscription_.contractAddress,
                subscription_.topic0,
                subscription_.topic1,
                subscription_.topic2,
                subscription_.topic3
            )
        );
    }

    // -------------------------------------------------------------------------
    // Internal subscription management
    // -------------------------------------------------------------------------

    /// @dev Registers a criteria set and, unless paused, subscribes it on the node.
    ///      Re-registering the same criteria is a no-op so callers need not dedupe.
    /// @return id_ The criteria set id.
    /// @return isNew_ True if this criteria set had never been seen before.
    function _addSubscription(Subscription memory subscription_) internal returns (bytes32 id_, bool isNew_) {
        id_ = subscriptionId(subscription_);

        if (!_subscriptionKnown[id_]) {
            _subscriptionKnown[id_] = true;
            _subscriptions[id_] = subscription_;
            _subscriptionIds.push(id_);
            isNew_ = true;
        }

        if (!paused && !_subscriptionActive[id_]) {
            _subscriptionActive[id_] = true;
            _subscribe(subscription_);
            emit SubscriptionAdded(id_, subscription_);
        }
    }

    /// @dev Removes a criteria set permanently, unsubscribing it first if live.
    /// @custom:security This must fully forget the criteria, not merely mark it
    ///      inactive. A route registered while paused is never subscribed, so
    ///      `_subscriptionActive` is already false — an early return here would
    ///      leave the id tracked, and `unpause()` would then resurrect a revoked
    ///      route. The registry entry is therefore deleted outright.
    function _removeSubscription(Subscription memory subscription_) internal {
        bytes32 id = subscriptionId(subscription_);

        if (_subscriptionActive[id]) {
            _subscriptionActive[id] = false;
            _unsubscribe(subscription_);
        }

        if (_subscriptionKnown[id]) {
            _subscriptionKnown[id] = false;
            delete _subscriptions[id];

            uint256 length = _subscriptionIds.length;
            for (uint256 i = 0; i < length; ++i) {
                if (_subscriptionIds[i] == id) {
                    _subscriptionIds[i] = _subscriptionIds[length - 1];
                    _subscriptionIds.pop();
                    break;
                }
            }
        }

        emit SubscriptionRemoved(id, subscription_);
    }

    /// @dev Single place where the six criteria are handed to the node.
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

    /// @dev Single place where the six criteria are withdrawn. Must mirror `_subscribe` exactly.
    function _unsubscribe(Subscription memory subscription_) internal {
        SYSTEM.unsubscribe(
            subscription_.chainId,
            subscription_.contractAddress,
            subscription_.topic0,
            subscription_.topic1,
            subscription_.topic2,
            subscription_.topic3
        );
    }

    /// @dev Reverts when paused. Applied to `react()` so a stale delivery that
    ///      arrives between `pause()` and node-side teardown is a cheap no-op.
    ///      Note: reverting here is *not* used as a filter — see `SapuRSC.react`.
    // forge-lint: disable-next-line(modifier-used-only-once)
    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }
}
