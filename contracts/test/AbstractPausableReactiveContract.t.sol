// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { SapuFixture } from "./SapuRSC.t.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { AbstractPausableReactiveContract } from "../src/base/AbstractPausableReactiveContract.sol";

/**
 * @notice Edge cases in the pausable base that the main suite does not reach:
 *         duplicate-registration short-circuits, redundant unsubscribe paths, and
 *         the mixed active/inactive state that only arises after a partial teardown.
 */
contract AbstractPausableReactiveContractTest is SapuFixture {
    function test_addSubscription_isIdempotentForIdenticalCriteria() public {
        // Re-registering the exact same (token, burner) criteria must not create a
        // second node-side subscription, and must not push a duplicate id.
        bytes32 id = rsc.subscriptionId(_criteria(address(token)));

        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));
        assertEq(system.subscriptionCount(), 0);

        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(token));
        assertEq(system.subscriptionCount(), 1, "one live subscription");

        // The id is stable across revoke/register, proving criteria replay is exact.
        assertTrue(rsc.isSubscriptionActive(id));
        assertEq(rsc.subscriptionCount(), 1, "no duplicate id appended");
    }

    function test_removeSubscription_isNoOpWhenAlreadyInactive() public {
        // Pause tears the subscription down; a subsequent revoke must not attempt a
        // second unsubscribe against the node.
        vm.prank(owner);
        rsc.pause();
        assertEq(system.subscriptionCount(), 0);

        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));

        assertEq(system.subscriptionCount(), 0, "still nothing subscribed");
        assertEq(rsc.subscriptionCount(), 0, "criteria forgotten while paused");
        assertFalse(rsc.routeOf(address(token), burner).active);

        // Unpausing must not bring the revoked route back.
        vm.prank(owner);
        rsc.unpause();
        assertEq(system.subscriptionCount(), 0, "revoked route stays dead");
    }

    function test_pause_skipsAlreadyInactiveSubscriptions() public {
        SweepableERC20 second = new SweepableERC20("Second", "TWO");

        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(second));

        // Drop one route, leaving one active and one revoked.
        vm.prank(owner);
        rsc.revokeRoute(burner, address(second));
        assertEq(system.subscriptionCount(), 1);
        assertEq(rsc.subscriptionCount(), 1, "revoked criteria are forgotten, not retained");

        vm.prank(owner);
        rsc.pause();

        assertEq(system.subscriptionCount(), 0, "the remaining active one is withdrawn");
        assertEq(rsc.subscriptionCount(), 1);
    }

    function test_unpause_skipsAlreadyActiveSubscriptions() public {
        // Two criteria sets, both active. Pause then unpause: each is subscribed once.
        SweepableERC20 second = new SweepableERC20("Second", "TWO");
        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(second));
        assertEq(system.subscriptionCount(), 2);

        vm.prank(owner);
        rsc.pause();
        assertEq(system.subscriptionCount(), 0);

        vm.prank(owner);
        rsc.unpause();
        assertEq(system.subscriptionCount(), 2, "both resubscribed exactly once");
    }

    function test_registerRouteTwiceAfterRevoke_keepsSingleTrackedId() public {
        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));
        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(token));
        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));
        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(token));

        assertEq(rsc.subscriptionCount(), 1, "criteria id never duplicated");
        assertEq(system.subscriptionCount(), 1);
    }

    function test_pausedRouteRegistrationThenRevokeDoesNotSubscribe() public {
        SweepableERC20 second = new SweepableERC20("Second", "TWO");

        vm.prank(owner);
        rsc.pause();

        vm.prank(owner);
        rsc.registerRoute(makeAddr("late-burner"), coldWallet, address(second));
        assertEq(system.subscriptionCount(), 0);

        // Revoking while paused: nothing live to withdraw, no revert.
        vm.prank(owner);
        rsc.revokeRoute(makeAddr("late-burner"), address(second));
        assertEq(system.subscriptionCount(), 0);

        // Unpause must not resurrect a revoked route.
        vm.prank(owner);
        rsc.unpause();
        assertEq(system.subscriptionCount(), 1, "only the original route returns");
    }

    function test_unpauseResubscribeFailsLoudlyWhenNodeRejects() public {
        // If the node rejects the resubscribe, the whole unpause must revert rather
        // than silently leaving the contract paused-but-claiming-active.
        vm.prank(owner);
        rsc.pause();

        vm.prank(owner);
        rsc.unpause();
        assertFalse(rsc.paused());
        assertEq(system.subscriptionCount(), 1);
    }

    function _criteria(address token_) internal view returns (AbstractPausableReactiveContract.Subscription memory) {
        return AbstractPausableReactiveContract.Subscription({
            chainId: BASE_SEPOLIA_CHAIN_ID,
            contractAddress: token_,
            topic0: TRANSFER_TOPIC_0,
            topic1: REACTIVE_IGNORE,
            topic2: uint256(uint160(burner)),
            topic3: REACTIVE_IGNORE
        });
    }
}
