// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title CallbackProxySimulator
 * @notice TEST-ONLY stand-in for the Reactive Network callback proxy.
 *
 * @dev ## Scope — same caveat as `MockSystemContract`
 *
 *      This contract is never deployed by anything in `contracts/script/`, never
 *      referenced by the app, and never reachable from the demo path. It exists so
 *      `forge test` can reproduce the *two* things the real proxy does that the
 *      forwarder's security depends on:
 *
 *      1. It is the `msg.sender` that the forwarder sees, so `onlyServiceProvider`
 *         passes only for this address — exactly as the real proxy at
 *         `0x476F44b11F5C942c58f4c8E3d0300E5710743585` on Base Sepolia.
 *
 *      2. It overwrites the first 160 bits of the payload with the requesting
 *         reactive contract's address, so `onlyCallbackSender` has something
 *         meaningful to check.
 *
 *      Splitting this from `MockSystemContract` matters: the system contract lives
 *      on Reactive Lasna and the proxy lives on the destination chain, so they are
 *      genuinely two different addresses. Conflating them would make the tests pass
 *      for the wrong reason.
 */
contract CallbackProxySimulator {
    /// @notice One pending delivery.
    /// @param chainId Destination chain id.
    /// @param requester Reactive contract that requested the callback.
    /// @param recipient Contract to call on the destination chain.
    /// @param gasLimit Requested gas limit.
    /// @param payload ABI-encoded call, first word reserved for the requester.
    struct Pending {
        uint256 chainId;
        address requester;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Pending[] public pending;

    /// @notice Outstanding callback debt per payer. Mirrors `IPayable.debt` so the
    ///         forwarder's `_coverDebt()` works against this simulator.
    mapping(address => uint256) public debt;

    /// @notice Sets a simulated outstanding debt.
    function setDebt(address payer_, uint256 amount_) external {
        debt[payer_] = amount_;
    }

    /// @notice Accepts payment and clears the payer's debt, as the real proxy does.
    receive() external payable {
        debt[msg.sender] = 0;
    }

    /// @notice Records a callback for later delivery.
    function enqueue(
        uint256 chainId_,
        address requester_,
        address recipient_,
        uint64 gasLimit_,
        bytes memory payload_
    ) external {
        pending.push(
            Pending({
                chainId: chainId_,
                requester: requester_,
                recipient: recipient_,
                gasLimit: gasLimit_,
                payload: payload_
            })
        );
    }

    /// @notice Number of queued deliveries.
    function pendingCount() external view returns (uint256) {
        return pending.length;
    }

    /// @notice Delivers a queued callback exactly as the real proxy would.
    /// @param index_ Index into `pending`.
    /// @return success_ Whether the destination call succeeded.
    /// @return returnData_ Raw return data (or revert reason) from the destination.
    function deliver(uint256 index_) external returns (bool success_, bytes memory returnData_) {
        Pending memory item = pending[index_];
        bytes memory payload = item.payload;
        address requester = item.requester;

        // The real proxy replaces the first 160 bits of the *argument area* with the
        // requesting RSC address. The 4-byte selector stays intact, so the first
        // argument must be the `address(0)` placeholder, which is overwritten here.
        //
        // ABI layout of `payload`: [0..3] selector, [4..35] arg0, [36..67] arg1, ...
        // arg0 is a left-padded address, so its meaningful 20 bytes are [16..35].
        //
        // Written as an explicit byte loop rather than inline assembly: this is a
        // test double that must be obviously correct, and a silent misalignment here
        // would make the forwarder's authentication check pass for the wrong reason.
        for (uint256 i = 0; i < 20; ++i) {
            payload[16 + i] = bytes20(requester)[i];
        }

        (success_, returnData_) = item.recipient.call{ gas: item.gasLimit }(payload);
    }
}
