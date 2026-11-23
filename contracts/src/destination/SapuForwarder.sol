// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractCallback } from "@reactive/base/AbstractCallback.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ISapuForwarder } from "../interfaces/ISapuForwarder.sol";

/**
 * @title SapuForwarder
 * @notice Destination-side executor. Receives a Reactive Network callback and moves
 *         the deposited tokens from the burner to the user's cold wallet.
 *
 * @dev The burner never signs, never holds native gas, and never sends a transaction.
 *      Its only on-chain footprint is the inbound ERC-20 `Transfer` and the outbound
 *      one — the sweep.
 *
 * @dev ## Authentication
 *
 *      Two independent checks are required and both are applied:
 *
 *      - `onlyServiceProvider` — `msg.sender` must be the callback proxy. Without it
 *        anyone could call `executeSweep` directly and forge the injected address.
 *      - `onlyCallbackSender(reactiveSender_)` — the address injected into the first
 *        payload word must be the `SapuRSC` authorized at construction. Without it any
 *        reactive contract on the network could drive this forwarder through the
 *        legitimate proxy.
 *
 *      `_CALLBACK_SENDER` is immutable by design; a typo there means redeploying.
 *
 * @dev ## Defence in depth: the armed rule is re-checked here
 *
 *      `SapuRSC` is trusted, but this contract does not rely on that trust. It keeps
 *      its own `(token, burner) -> coldWallet` registry and rejects any callback whose
 *      destination disagrees. A compromised or upgraded RSC therefore cannot redirect
 *      a sweep to an attacker's address. See docs/LIMITATIONS.md.
 */
contract SapuForwarder is AbstractCallback, ISapuForwarder, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Arm-state for one (token, burner) pair.
    /// @param coldWallet Destination for swept funds.
    /// @param armed Whether the pair may be swept.
    struct Rule {
        address coldWallet;
        bool armed;
    }

    /// @dev token => burner => rule.
    mapping(address => mapping(address => Rule)) private _rules;

    /// @notice Total number of successful sweeps. Monotonic proof counter for the UI.
    uint256 public sweepCount;

    /// @notice Cumulative swept amount per token.
    mapping(address => uint256) public totalSwept;

    /// @notice Reverts when an argument that must be non-zero is zero.
    error InvalidArgument();

    /// @param callbackProxy_ Reactive callback proxy for this chain (Base Sepolia:
    ///        0x476F44b11F5C942c58f4c8E3d0300E5710743585).
    /// @param callbackSender_ The `SapuRSC` address authorized to drive this contract.
    /// @param initialOwner_ Operator allowed to arm rules.
    constructor(IPayable callbackProxy_, address callbackSender_, address initialOwner_)
        payable
        AbstractCallback(callbackProxy_, callbackSender_)
        Ownable(initialOwner_)
    {
        if (callbackSender_ == address(0) || initialOwner_ == address(0)) revert InvalidArgument();
    }

    // -------------------------------------------------------------------------
    // Callback entry point
    // -------------------------------------------------------------------------

    /// @inheritdoc ISapuForwarder
    /// @dev First parameter is overwritten by the callback proxy with the requesting
    ///      reactive contract's address, so it must stay in position 0 and be `address`.
    function executeSweep(
        address reactiveSender_,
        address token_,
        address burner_,
        address coldWallet_,
        uint256 amount_
    ) external onlyServiceProvider onlyCallbackSender(reactiveSender_) {
        Rule memory rule = _rules[token_][burner_];
        if (!rule.armed) revert RouteNotArmed(burner_, token_);

        // The RSC must not be able to retarget a sweep away from the user's cold wallet.
        if (rule.coldWallet != coldWallet_) revert DestinationMismatch(rule.coldWallet, coldWallet_);

        if (amount_ == 0) revert NothingToSweep(burner_, token_, amount_);

        IERC20 token = IERC20(token_);
        uint256 balance = token.balanceOf(burner_);

        // Never move more than is actually there. The RSC's `amount` is the deposit
        // size; if the burner was already drained, or a later deposit landed first,
        // sweeping the full balance is the correct and safe behaviour.
        uint256 sweepAmount = amount_ > balance ? balance : amount_;
        if (sweepAmount == 0) revert NothingToSweep(burner_, token_, amount_);

        // Pull via the standing allowance. `safeTransferFrom` reverts on a false return
        // (e.g. tokens that return no bool), which surfaces as `CallbackFailure`.
        //
        // An arbitrary `from` is the entire point of this contract: the burner is a
        // third-party address by design, and it authorized exactly this pull by
        // signing an EIP-2612 permit. The allowance check inside `transferFrom` is the
        // authorization boundary, not `msg.sender`.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        token.safeTransferFrom(burner_, coldWallet_, sweepAmount);

        unchecked {
            ++sweepCount;
        }
        totalSwept[token_] += sweepAmount;

        emit TokensSwept(burner_, token_, coldWallet_, sweepAmount, reactiveSender_);
    }

    // -------------------------------------------------------------------------
    // Allowance arming (gasless from the burner's perspective)
    // -------------------------------------------------------------------------

    /// @notice Consumes an EIP-2612 permit signed by the burner, granting this
    ///         contract a standing allowance. The burner signs off-chain for free.
    /// @dev Permissionless submission: any relayer can call this. The signature is
    ///      what authorizes the allowance, not the caller.
    /// @param token_ Permit-capable ERC-20.
    /// @param burner_ Signer / allowance owner.
    /// @param value_ Allowance to grant.
    /// @param deadline_ Permit expiry (unix seconds).
    /// @param v_ Signature v.
    /// @param r_ Signature r.
    /// @param s_ Signature s.
    function armWithPermit(
        address token_,
        address burner_,
        uint256 value_,
        uint256 deadline_,
        uint8 v_,
        bytes32 r_,
        bytes32 s_
    ) external {
        IERC20Permit(token_).permit(burner_, address(this), value_, deadline_, v_, r_, s_);
        emit PermitArmed(token_, burner_, value_, deadline_);
    }

    // -------------------------------------------------------------------------
    // Operator surface
    // -------------------------------------------------------------------------

    /// @notice Arms or updates the destination rule for a (token, burner) pair.
    /// @dev Must be armed before the first deposit lands, otherwise the callback
    ///      reverts with `RouteNotArmed` and the deposit sits in the burner until
    ///      the rule is added and a later deposit re-triggers the loop.
    function armRoute(address token_, address burner_, address coldWallet_) external onlyOwner {
        if (token_ == address(0) || burner_ == address(0) || coldWallet_ == address(0)) {
            revert InvalidArgument();
        }
        _rules[token_][burner_] = Rule({ coldWallet: coldWallet_, armed: true });
        emit RouteArmed(burner_, token_, coldWallet_);
    }

    /// @notice Disarms a rule.
    function disarmRoute(address token_, address burner_) external onlyOwner {
        delete _rules[token_][burner_];
        emit RouteDisarmed(burner_, token_);
    }

    /// @notice Moves tokens that are already sitting in a burner to the cold wallet
    ///         recorded in that burner's armed rule.
    ///
    /// @dev ## Why this exists
    ///
    ///      `executeSweep` moves `min(amount_, balance)`, and `amount_` is always the
    ///      size of the Transfer that triggered it. A sweep therefore moves exactly
    ///      the triggering deposit and can never drain a balance that was already
    ///      there. If a callback fails (no allowance, low gas, debt, one side
    ///      disarmed), that deposit is stranded and no later deposit can recover it.
    ///
    ///      This is the recovery path for exactly that case. It is not a second sweep
    ///      path: it cannot be used to move tokens that a sweep would have moved,
    ///      because it requires the rule to be armed and it targets the same cold
    ///      wallet the loop would have used.
    ///
    /// @dev ## Why the owner cannot redirect the funds
    ///
    ///      The destination is read from storage, not from an argument. There is no
    ///      `to` parameter, so the owner can only ever send a burner's tokens to the
    ///      cold wallet that burner was armed with. To retarget, the owner would have
    ///      to call `armRoute`, which emits `RouteArmed` and is a visible, logged act.
    ///      This preserves the property that the forwarder cannot be pointed at an
    ///      attacker by a single privileged call.
    ///
    /// @param token_ ERC-20 to move.
    /// @param burner_ Burner currently holding the tokens.
    function rescueSweep(address token_, address burner_) external onlyOwner {
        Rule memory rule = _rules[token_][burner_];
        if (!rule.armed) revert RouteNotArmed(burner_, token_);

        address coldWallet_ = rule.coldWallet;
        uint256 balance = IERC20(token_).balanceOf(burner_);
        if (balance == 0) revert NothingToSweep(burner_, token_, balance);

        // Same authorization boundary as `executeSweep`: the standing allowance the
        // burner granted. The owner never gains the ability to move tokens the burner
        // did not authorize this contract to move.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        IERC20(token_).safeTransferFrom(burner_, coldWallet_, balance);

        unchecked {
            ++sweepCount;
        }
        totalSwept[token_] += balance;

        // `reactiveSender_` is `address(0)`: this sweep was not requested by the RSC.
        // Keeping the event shape identical means the ledger can decode a rescue with
        // the same decoder, and the zero sender is what distinguishes it from a
        // callback-driven sweep.
        emit TokensSwept(burner_, token_, coldWallet_, balance, address(0));
    }

    /// @notice Settles outstanding callback debt from this contract's own balance.
    /// @dev Permissionless: a contract in debt receives no callbacks, so letting
    ///      anyone top it up and settle keeps the loop alive.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice Reads the armed rule for a (token, burner) pair.
    function ruleOf(address token_, address burner_) external view returns (Rule memory) {
        return _rules[token_][burner_];
    }
}
