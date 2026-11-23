// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { SapuFixture } from "./SapuRSC.t.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { ISapuForwarder } from "../src/interfaces/ISapuForwarder.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Tests for the destination-side executor.
 * @dev Calls arrive through `CallbackProxySimulator` (the `onlyServiceProvider` caller)
 *      and carry the RSC address injected into arg0 (the `onlyCallbackSender` check).
 */
contract SapuForwarderTest is SapuFixture {
    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_executeSweep_movesTokensToColdWallet() public {
        token.mint(burner, 3e18);
        _deliver(_transferLog(depositor, burner, 3e18, address(token)));

        vm.expectEmit(true, true, true, true, address(forwarder));
        emit ISapuForwarder.TokensSwept(burner, address(token), coldWallet, 3e18, address(rsc));

        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);
        assertTrue(ok);

        assertEq(token.balanceOf(coldWallet), 3e18, "cold wallet received the deposit");
        assertEq(token.balanceOf(burner), 0, "burner is empty");
        assertEq(forwarder.sweepCount(), 1);
        assertEq(forwarder.totalSwept(address(token)), 3e18);
    }

    function test_executeSweep_burnerNeverNeedsGas() public {
        // The burner holds zero native balance for the whole flow.
        assertEq(burner.balance, 0, "precondition: burner has no gas");

        _runLoop(1e18);

        assertEq(burner.balance, 0, "burner still has no gas");
        assertEq(token.balanceOf(coldWallet), 1e18);
    }

    function test_executeSweep_accumulatesAcrossDeposits() public {
        _runLoop(1e18);
        _runLoop(2e18);
        _runLoop(3e18);

        assertEq(token.balanceOf(coldWallet), 6e18);
        assertEq(forwarder.sweepCount(), 3);
        assertEq(forwarder.totalSwept(address(token)), 6e18);
    }

    function test_executeSweep_clampsToAvailableBalance() public {
        // Deposit 5, but only 2 actually present (simulates a prior drain or a
        // log that outruns the balance). Must move what exists, not revert.
        token.mint(burner, 2e18);
        _deliver(_transferLog(depositor, burner, 5e18, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);

        assertTrue(ok, "sweep should succeed with clamped amount");
        assertEq(token.balanceOf(coldWallet), 2e18);
        assertEq(token.balanceOf(burner), 0);
    }

    /// @notice A later deposit can never clear an already-stranded balance.
    /// @dev `executeSweep` moves `min(amount_, balance)`, and `amount_` is the size of
    ///      the triggering Transfer, so a fresh deposit of D moves exactly D. Whatever
    ///      was already in the burner stays. This test pins that arithmetic down
    ///      because it is the reason "send another deposit" is not a recovery path.
    function test_executeSweep_aLaterDepositCannotClearAnExistingResidue() public {
        token.mint(burner, 1e18); // stranded: no log ever triggered a sweep for it

        _runLoop(1e18); // a fresh deposit of the same size

        assertEq(token.balanceOf(coldWallet), 1e18, "only the new deposit moved");
        assertEq(token.balanceOf(burner), 1e18, "the old residue is still in the burner");
    }

    /// @notice Even an oversized deposit leaves the residue untouched.
    /// @dev Sweep amount is clamped to the triggering deposit, not to the balance, so
    ///      depositing more than the residue does not sweep the residue either.
    function test_executeSweep_oversizedDepositStillLeavesTheResidue() public {
        token.mint(burner, 1e18); // stranded

        _runLoop(5e18); // deposit five times the residue

        assertEq(token.balanceOf(coldWallet), 5e18, "only the triggering deposit moved");
        assertEq(token.balanceOf(burner), 1e18, "residue survives any deposit size");
    }

    // -------------------------------------------------------------------------
    // Rescue — the recovery path for a residue that no deposit can clear
    // -------------------------------------------------------------------------

    function test_rescueSweep_movesResidueToArmedColdWallet() public {
        token.mint(burner, 1e18); // stranded, no callback ever succeeded

        vm.prank(owner);
        forwarder.rescueSweep(address(token), burner);

        assertEq(token.balanceOf(coldWallet), 1e18, "residue reached the cold wallet");
        assertEq(token.balanceOf(burner), 0, "burner is finally empty");
        assertEq(forwarder.sweepCount(), 1, "rescue counts as a sweep");
        assertEq(forwarder.totalSwept(address(token)), 1e18);
    }

    function test_rescueSweep_emitsZeroReactiveSender() public {
        token.mint(burner, 1e18);

        // The zero sender is how a rescue is distinguished from a callback sweep in
        // the event stream, so it is part of the contract, not an implementation detail.
        vm.expectEmit(true, true, true, true, address(forwarder));
        emit ISapuForwarder.TokensSwept(burner, address(token), coldWallet, 1e18, address(0));

        vm.prank(owner);
        forwarder.rescueSweep(address(token), burner);
    }

    function test_rescueSweep_alwaysTargetsTheArmedColdWallet() public {
        token.mint(burner, 1e18);

        // The owner has no `to` argument to abuse: the destination comes from the
        // armed rule, so neither the owner nor an attacker address can receive it.
        vm.prank(owner);
        forwarder.rescueSweep(address(token), burner);

        assertEq(token.balanceOf(coldWallet), 1e18);
        assertEq(token.balanceOf(owner), 0, "owner cannot receive the funds");
        assertEq(token.balanceOf(attacker), 0, "attacker cannot receive the funds");
    }

    function test_rescueSweep_worksWhenTheRscRouteWasRevoked() public {
        // The classic one-sided failure: the RSC side was revoked, so no callback can
        // ever fire, but the forwarder rule is still armed. Rescue is the only way out.
        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));

        token.mint(burner, 1e18);

        vm.prank(owner);
        forwarder.rescueSweep(address(token), burner);

        assertEq(token.balanceOf(coldWallet), 1e18);
        assertEq(token.balanceOf(burner), 0);
    }

    function test_rescueSweep_revertsWhenNotOwner() public {
        token.mint(burner, 1e18);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        forwarder.rescueSweep(address(token), burner);
    }

    function test_rescueSweep_revertsWhenRuleNotArmed() public {
        token.mint(burner, 1e18);

        vm.prank(owner);
        forwarder.disarmRoute(address(token), burner);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ISapuForwarder.RouteNotArmed.selector, burner, address(token)));
        forwarder.rescueSweep(address(token), burner);
    }

    function test_rescueSweep_revertsWhenBurnerIsEmpty() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ISapuForwarder.NothingToSweep.selector, burner, address(token), 0));
        forwarder.rescueSweep(address(token), burner);
    }

    function test_rescueSweep_revertsWithoutAllowance() public {
        // The owner still cannot move tokens the burner never authorized: the standing
        // allowance remains the authorization boundary on the rescue path too.
        vm.prank(burner);
        token.approve(address(forwarder), 0);
        token.mint(burner, 1e18);

        vm.prank(owner);
        vm.expectRevert();
        forwarder.rescueSweep(address(token), burner);

        assertEq(token.balanceOf(burner), 1e18, "funds stayed put");
    }

    // -------------------------------------------------------------------------
    // Authentication — the two guards
    // -------------------------------------------------------------------------

    function test_executeSweep_revertsWhenCallerIsNotProxy() public {
        token.mint(burner, 1e18);

        // Attacker calls directly, injecting the real RSC address to defeat guard #2.
        vm.prank(attacker);
        vm.expectRevert();
        forwarder.executeSweep(address(rsc), address(token), burner, coldWallet, 1e18);
    }

    function test_executeSweep_revertsWhenCallbackSenderIsWrong() public {
        token.mint(burner, 1e18);

        // Through the legitimate proxy, but claiming a different reactive contract.
        address fakeRsc = makeAddr("fake-rsc");
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(
                // AbstractCallback.CallbackNotAuthorized
                bytes4(keccak256("CallbackNotAuthorized(address,address)")), fakeRsc, address(rsc)
            )
        );
        forwarder.executeSweep(fakeRsc, address(token), burner, coldWallet, 1e18);
    }

    function test_executeSweep_rejectsCallbackFromForeignRSC() public {
        // A second, attacker-controlled RSC must not be able to drive this forwarder
        // even though it goes through the genuine proxy.
        SapuRSC rogue = new SapuRSC(attacker, BASE_SEPOLIA_CHAIN_ID);
        token.mint(burner, 1e18);

        vm.prank(attacker);
        rogue.setForwarder(address(forwarder));
        vm.prank(attacker);
        rogue.registerRoute(burner, attacker, address(token));

        // The rogue RSC requests a callback; the proxy delivers it faithfully.
        vm.prank(SYSTEM_ADDR);
        rogue.react(_transferLog(depositor, burner, 1e18, address(token)));

        (bool ok, bytes memory ret) = proxy.deliver(proxy.pendingCount() - 1);
        assertFalse(ok, "rogue RSC callback must fail");
        assertEq(token.balanceOf(attacker), 0, "attacker received nothing");
        assertEq(token.balanceOf(coldWallet), 0);
        assertGt(ret.length, 0, "reverted with a reason");
    }

    // -------------------------------------------------------------------------
    // Armed-rule defence in depth
    // -------------------------------------------------------------------------

    function test_executeSweep_revertsWhenRuleNotArmed() public {
        token.mint(burner, 1e18);
        vm.prank(owner);
        forwarder.disarmRoute(address(token), burner);

        _deliver(_transferLog(depositor, burner, 1e18, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);

        assertFalse(ok, "disarmed rule must block the sweep");
        assertEq(token.balanceOf(coldWallet), 0);
        assertEq(token.balanceOf(burner), 1e18, "funds stay put");
    }

    function test_executeSweep_revertsOnDestinationMismatch() public {
        // Even the trusted RSC cannot retarget a sweep away from the armed cold wallet.
        token.mint(burner, 1e18);
        address attackerWallet = makeAddr("attacker-wallet");

        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(abi.encodeWithSelector(ISapuForwarder.DestinationMismatch.selector, coldWallet, attackerWallet));
        forwarder.executeSweep(address(rsc), address(token), burner, attackerWallet, 1e18);
    }

    function test_executeSweep_revertsOnZeroAmount() public {
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(abi.encodeWithSelector(ISapuForwarder.NothingToSweep.selector, burner, address(token), 0));
        forwarder.executeSweep(address(rsc), address(token), burner, coldWallet, 0);
    }

    function test_executeSweep_revertsWhenBurnerBalanceIsZero() public {
        // No tokens minted at all.
        vm.prank(CALLBACK_PROXY);
        vm.expectRevert(abi.encodeWithSelector(ISapuForwarder.NothingToSweep.selector, burner, address(token), 1e18));
        forwarder.executeSweep(address(rsc), address(token), burner, coldWallet, 1e18);
    }

    // -------------------------------------------------------------------------
    // Allowance arming
    // -------------------------------------------------------------------------

    function test_executeSweep_revertsWithoutAllowance() public {
        // A fresh burner that never armed an allowance: the sweep must fail rather
        // than silently do nothing, so the failure is visible as CallbackFailure.
        address freshBurner = makeAddr("fresh-burner");
        vm.prank(owner);
        rsc.registerRoute(freshBurner, coldWallet, address(token));
        vm.prank(owner);
        forwarder.armRoute(address(token), freshBurner, coldWallet);

        token.mint(freshBurner, 1e18);

        vm.prank(CALLBACK_PROXY);
        vm.expectRevert();
        forwarder.executeSweep(address(rsc), address(token), freshBurner, coldWallet, 1e18);
    }

    function test_armWithPermit_grantsAllowanceAndEnablesSweep() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("permit-burner");
        address permitCold = makeAddr("permit-cold");

        vm.prank(owner);
        rsc.registerRoute(signer, permitCold, address(token));
        vm.prank(owner);
        forwarder.armRoute(address(token), signer, permitCold);

        token.mint(signer, 7e18);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer,
                address(forwarder),
                7e18,
                token.nonces(signer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        // Any relayer may submit: the signature is the authorization, not the caller.
        vm.prank(attacker);
        forwarder.armWithPermit(address(token), signer, 7e18, deadline, v, r, s);

        assertEq(token.allowance(signer, address(forwarder)), 7e18);

        _deliver(_transferLog(depositor, signer, 7e18, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);

        assertTrue(ok);
        assertEq(token.balanceOf(permitCold), 7e18);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function test_armRoute_revertsWhenNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        forwarder.armRoute(address(token), burner, coldWallet);
    }

    function test_armRoute_revertsOnZeroArguments() public {
        vm.startPrank(owner);
        vm.expectRevert(SapuForwarder.InvalidArgument.selector);
        forwarder.armRoute(address(0), burner, coldWallet);
        vm.expectRevert(SapuForwarder.InvalidArgument.selector);
        forwarder.armRoute(address(token), address(0), coldWallet);
        vm.expectRevert(SapuForwarder.InvalidArgument.selector);
        forwarder.armRoute(address(token), burner, address(0));
        vm.stopPrank();
    }

    function test_disarmRoute_removesRule() public {
        vm.prank(owner);
        forwarder.disarmRoute(address(token), burner);
        SapuForwarder.Rule memory rule = forwarder.ruleOf(address(token), burner);
        assertFalse(rule.armed);
        assertEq(rule.coldWallet, address(0));
    }

    function test_constructor_revertsOnZeroCallbackSender() public {
        vm.expectRevert(SapuForwarder.InvalidArgument.selector);
        new SapuForwarder(IPayableFixture.payableProxy(), address(0), owner);
    }

    function test_constructor_revertsOnZeroOwner() public {
        // OZ 5.x Ownable rejects address(0) before SAPU's own check is reached.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SapuForwarder(IPayableFixture.payableProxy(), address(rsc), address(0));
    }

    function test_coverDebt_settlesOutstandingDebt() public {
        proxy.setDebt(address(forwarder), 1 ether);
        vm.deal(address(forwarder), 1 ether);

        forwarder.coverDebt();

        assertEq(address(forwarder).balance, 0);
        assertEq(proxy.debt(address(forwarder)), 0, "proxy zeroes debt on payment");
    }

    function test_receive_acceptsFunding() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(forwarder).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(forwarder).balance, 1 ether);
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function testFuzz_executeSweep_exactAmount(uint96 amount_) public {
        uint256 amount = bound(uint256(amount_), 1, type(uint96).max);
        token.mint(burner, amount);
        _deliver(_transferLog(depositor, burner, amount, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);

        assertTrue(ok);
        assertEq(token.balanceOf(coldWallet), amount);
        assertEq(token.balanceOf(burner), 0);
    }

    function testFuzz_executeSweep_neverExceedsBalance(uint96 minted_, uint96 claimed_) public {
        uint256 minted = bound(uint256(minted_), 1, type(uint96).max);
        uint256 claimed = bound(uint256(claimed_), 1, type(uint96).max);

        token.mint(burner, minted);
        _deliver(_transferLog(depositor, burner, claimed, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);

        if (claimed > minted) {
            assertTrue(ok, "clamped sweep succeeds");
            assertEq(token.balanceOf(coldWallet), minted, "swept exactly the balance");
        } else {
            assertTrue(ok);
            assertEq(token.balanceOf(coldWallet), claimed);
        }
        assertEq(token.balanceOf(burner), minted - token.balanceOf(coldWallet));
    }
}

/// @dev Small helper so the constructor tests can build an `IPayable` argument.
library IPayableFixture {
    function payableProxy() internal pure returns (IPayable) {
        return IPayable(payable(0x476F44b11F5C942c58f4c8E3d0300E5710743585));
    }
}
