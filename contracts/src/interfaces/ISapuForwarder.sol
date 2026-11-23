// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title ISapuForwarder
 * @notice Destination-side surface that `SapuRSC` is allowed to call, plus the
 *         operator-facing rule registry.
 *
 * @dev `executeSweep` reserves its first parameter as an `address`. Reactive
 *      Network overwrites the first 160 bits of every callback payload with the
 *      address of the reactive contract that requested it, so the destination can
 *      authenticate the origin. See docs/SPEC-REACTIVE-LOOP.md.
 */
interface ISapuForwarder {
    /// @notice Emitted for every successful sweep. This is the Tx3 proof artefact.
    /// @param burner_ Burner address whose tokens were moved.
    /// @param token_ ERC-20 that was swept.
    /// @param coldWallet_ Destination that received the tokens.
    /// @param amount_ Amount transferred, in token base units.
    /// @param reactiveSender_ Reactive contract that requested the callback.
    event TokensSwept(
        address indexed burner_,
        address indexed token_,
        address indexed coldWallet_,
        uint256 amount_,
        address reactiveSender_
    );

    /// @notice Emitted when an off-chain EIP-2612 signature is consumed to arm a standing allowance.
    /// @param token_ ERC-20 the permit applies to.
    /// @param burner_ Owner that signed the permit.
    /// @param value_ Allowance granted to this forwarder.
    /// @param deadline_ Permit expiry.
    event PermitArmed(address indexed token_, address indexed burner_, uint256 value_, uint256 deadline_);

    /// @notice Emitted when the operator registers or replaces a sweep destination.
    event RouteArmed(address indexed burner_, address indexed token_, address indexed coldWallet_);

    /// @notice Emitted when the operator removes a sweep destination.
    event RouteDisarmed(address indexed burner_, address indexed token_);

    /// @notice Reverts when no destination rule is armed for the (burner, token) pair.
    error RouteNotArmed(address burner_, address token_);

    /// @notice Reverts when the destination in the callback does not match the armed rule.
    error DestinationMismatch(address expected_, address received_);

    /// @notice Reverts when the sweep amount is zero or the burner lacks balance.
    error NothingToSweep(address burner_, address token_, uint256 amount_);

    /// @notice Sweeps tokens from a burner to its armed cold wallet. Callback-only.
    /// @param reactiveSender_ Injected by the Reactive Network callback proxy.
    /// @param token_ ERC-20 to move.
    /// @param burner_ Source of the funds.
    /// @param coldWallet_ Destination; must equal the armed rule.
    /// @param amount_ Amount in token base units.
    function executeSweep(
        address reactiveSender_,
        address token_,
        address burner_,
        address coldWallet_,
        uint256 amount_
    ) external;

    /// @notice Moves whatever a burner still holds to its armed cold wallet. Owner-only.
    /// @dev Recovery path for a deposit whose callback failed. The destination is read
    ///      from the armed rule, never from an argument, so the owner cannot retarget
    ///      the funds. Emits `TokensSwept` with `reactiveSender_ = address(0)`.
    /// @param token_ ERC-20 to move.
    /// @param burner_ Burner currently holding the tokens.
    function rescueSweep(address token_, address burner_) external;
}
