// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ReentrantToken
 * @notice TEST-ONLY ERC-20 that re-enters the forwarder from inside `transferFrom`.
 *
 * @dev ## What this actually proves
 *
 *      `SapuForwarder.executeSweep` moves `min(amount_, balance)` — deliberately, so a
 *      later deposit cannot make a sweep drain more than the Transfer that triggered it —
 *      then updates `sweepCount` and `totalSwept`. A token that re-enters during
 *      `transferFrom` sees the burner's balance already reduced but the counters not yet
 *      written, and can start a second sweep that moves *another* `amount_`.
 *
 *      That is a real double-move, not a theoretical one: with a 3e18 balance and a 1e18
 *      triggering deposit, the unguarded flow moves 2e18 for one deposit and reports
 *      `sweepCount == 2`. The `nonReentrant` guard is what keeps a sweep to exactly the
 *      deposit that triggered it.
 *
 *      ## Why the token plays the proxy
 *
 *      The re-entrant call has to reach the guarded body, which means it must clear
 *      `onlyServiceProvider` and `onlyCallbackSender` first. A token calling the
 *      forwarder directly fails `onlyServiceProvider` and "reverts" for a reason that has
 *      nothing to do with the reentrancy guard — a test that passes for the wrong reason.
 *
 *      So this token is deployed as *both* the callback proxy and the authorized callback
 *      sender. The re-entrant call is then indistinguishable from a legitimate second
 *      callback, leaving `nonReentrant` as the only check able to refuse it.
 *
 *      The recorded `reentryRevertData` is asserted against the guard's own selector, so
 *      an incidental revert (e.g. `NothingToSweep`) cannot satisfy the test.
 *
 *      Never deployed by a script, never referenced by the app, unreachable from the
 *      demo path.
 */
contract ReentrantToken is IERC20 {
    string public name = "Reentrant";
    string public symbol = "REENT";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice The forwarder this token drives and then re-enters.
    address public forwarder;
    /// @notice Calldata replayed on re-entry.
    bytes public payload;
    /// @notice Set when the re-entrant call did NOT revert, i.e. the guard failed.
    bool public attackSucceeded;
    /// @notice Set when the re-entrant call reverted as expected.
    bool public reentryReverted;
    /// @notice Raw revert data from the re-entrant call.
    /// @dev Asserted against `ReentrancyGuardReentrantCall.selector` so the test cannot be
    ///      satisfied by an incidental revert from an earlier check.
    bytes public reentryRevertData;

    bool private _entered;

    /// @notice Arms the re-entry: which forwarder to attack and with what calldata.
    function configure(address forwarder_, bytes calldata payload_) external {
        forwarder = forwarder_;
        payload = payload_;
    }

    function mint(address to_, uint256 amount_) external {
        balanceOf[to_] += amount_;
        emit Transfer(address(0), to_, amount_);
    }

    /// @notice Outer entry point: starts a sweep as the authorized callback proxy.
    /// @dev `msg.sender` to the forwarder is this token, which the test deploys the
    ///      forwarder to trust as both proxy and callback sender.
    function attack(address token_, address burner_, address coldWallet_, uint256 amount_) external {
        SapuForwarderLike(forwarder).executeSweep(address(this), token_, burner_, coldWallet_, amount_);
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        balanceOf[msg.sender] -= amount_;
        balanceOf[to_] += amount_;
        emit Transfer(msg.sender, to_, amount_);
        return true;
    }

    function approve(address spender_, uint256 amount_) external returns (bool) {
        allowance[msg.sender][spender_] = amount_;
        emit Approval(msg.sender, spender_, amount_);
        return true;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external returns (bool) {
        allowance[from_][msg.sender] -= amount_;
        balanceOf[from_] -= amount_;
        balanceOf[to_] += amount_;
        emit Transfer(from_, to_, amount_);

        // Re-enter exactly once, while the forwarder is mid-sweep: the balance has moved
        // but `sweepCount` / `totalSwept` have not been written yet.
        if (!_entered) {
            _entered = true;
            (bool ok, bytes memory revertData) = forwarder.call(payload);
            if (ok) {
                attackSucceeded = true;
            } else {
                reentryReverted = true;
                reentryRevertData = revertData;
            }
        }
        return true;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}

/// @dev Minimal forwarder surface used by `ReentrantToken`; avoids importing the real
///      contract (and its whole dependency tree) into a token mock.
interface SapuForwarderLike {
    function executeSweep(
        address reactiveSender_,
        address token_,
        address burner_,
        address coldWallet_,
        uint256 amount_
    ) external;
}
