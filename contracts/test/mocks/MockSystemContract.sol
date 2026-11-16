// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/interfaces/ISystemContract.sol";
import { CallbackProxySimulator } from "./CallbackProxySimulator.sol";

/**
 * @title MockSystemContract
 * @notice TEST-ONLY stand-in for the Reactive Omni system contract at
 *         `0x8888888888888888888888888888888888888888` on Lasna.
 *
 * @dev ## Scope of this mock — read before judging "no mocked chain state"
 *
 *      This contract exists so `forge test` can exercise `SapuRSC` in isolation. It
 *      is **never** deployed by any script in `contracts/script/`, never referenced by
 *      the app, and never reachable from the demo path. The production flow talks to
 *      the real system contract on Lasna (5318007) and real ERC-20 logs on Base
 *      Sepolia (84532); see docs/SPEC-REACTIVE-LOOP.md for the on-chain evidence.
 *
 *      It is etched over the system-contract address in tests via `vm.etch`, which is
 *      why it must match `ISystemContract` exactly.
 *
 *      Behaviours that matter for realistic tests:
 *
 *      - `subscribe`/`unsubscribe` record criteria so tests can assert the exact
 *        six-tuple the RSC sent. `unsubscribe` only removes an exact match, mirroring
 *        the real node's equality-only semantics.
 *      - `requestCallbackV_1_0` records the payload and forwards it to a
 *        `CallbackProxySimulator`, so a test can run the genuine two-hop flow:
 *        system contract (Lasna) -> proxy (Base Sepolia) -> forwarder. The two hops
 *        are different addresses in production, so they are different addresses here.
 */
contract MockSystemContract is ISystemContract {
    /// @notice One recorded subscription criteria set.
    struct Criteria {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    /// @notice One recorded callback request.
    struct CallbackRecord {
        address requester;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Criteria[] internal _subscriptions;
    CallbackRecord[] internal _callbacks;

    mapping(address => uint256) public debt;

    /// @notice When true, the next `requestCallbackV_1_0` reverts (failure-path tests).
    bool public failNextCallback;

    /// @notice Optional proxy simulator that callback requests are handed to.
    address public callbackProxySimulator;

    event CallbackRequest(
        uint256 indexed chainId,
        address indexed sender,
        address indexed recipient,
        CallbackVersion version,
        bytes configuration
    );

    function setFailNextCallback(bool value_) external {
        failNextCallback = value_;
    }

    function setCallbackProxySimulator(address simulator_) external {
        callbackProxySimulator = simulator_;
    }

    function setDebt(address contract_, uint256 amount_) external {
        debt[contract_] = amount_;
    }

    // -------------------------------------------------------------------------
    // ISubscriptionService
    // -------------------------------------------------------------------------

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external {
        _subscriptions.push(
            Criteria({
                chainId: chainId_,
                contractAddress: contract_,
                topic0: topic0_,
                topic1: topic1_,
                topic2: topic2_,
                topic3: topic3_
            })
        );
    }

    /// @dev Equality-only removal, exactly like the real node.
    function unsubscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external {
        uint256 length = _subscriptions.length;
        for (uint256 i = 0; i < length; ++i) {
            Criteria memory c = _subscriptions[i];
            if (
                c.chainId == chainId_ && c.contractAddress == contract_ && c.topic0 == topic0_
                    && c.topic1 == topic1_ && c.topic2 == topic2_ && c.topic3 == topic3_
            ) {
                _subscriptions[i] = _subscriptions[length - 1];
                _subscriptions.pop();
                return;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Callback requests
    // -------------------------------------------------------------------------

    function requestCallback(CallbackVersion version_, bytes memory config_) external {
        if (version_ != CallbackVersion.V_1_0) revert("bad version");
        CallbackConfiguration_V_1_0 memory cfg = abi.decode(config_, (CallbackConfiguration_V_1_0));
        _record(cfg);
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external {
        _record(config_);
    }

    function _record(CallbackConfiguration_V_1_0 memory config_) private {
        if (failNextCallback) {
            failNextCallback = false;
            revert("callback request failed");
        }

        _callbacks.push(
            CallbackRecord({
                requester: msg.sender,
                chainId: config_.chainId,
                recipient: config_.recipient,
                gasLimit: config_.gasLimit,
                payload: config_.payload
            })
        );

        address simulator = callbackProxySimulator;
        if (simulator != address(0)) {
            CallbackProxySimulator(payable(simulator)).enqueue(
                config_.chainId, msg.sender, config_.recipient, config_.gasLimit, config_.payload
            );
        }

        emit CallbackRequest(config_.chainId, msg.sender, config_.recipient, CallbackVersion.V_1_0, config_.payload);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function subscriptionCount() external view returns (uint256) {
        return _subscriptions.length;
    }

    function subscriptionAt(uint256 index_) external view returns (Criteria memory) {
        return _subscriptions[index_];
    }

    function callbackCount() external view returns (uint256) {
        return _callbacks.length;
    }

    function callbackAt(uint256 index_) external view returns (CallbackRecord memory) {
        return _callbacks[index_];
    }

    /// @notice Accepts payment and, like the real system contract, clears the
    ///         payer's outstanding debt on receipt.
    receive() external payable {
        debt[msg.sender] = 0;
    }
}
