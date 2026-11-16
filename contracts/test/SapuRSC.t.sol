// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { MockSystemContract } from "./mocks/MockSystemContract.sol";
import { CallbackProxySimulator } from "./mocks/CallbackProxySimulator.sol";
import { IReactive } from "@reactive/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/interfaces/ISystemContract.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";
import { AbstractPausableReactiveContract } from "../src/base/AbstractPausableReactiveContract.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Shared fixture for the SAPU test suite.
 * @dev `SYSTEM` is etched over the canonical address so `SapuRSC` talks to a contract
 *      that records what it was asked to do. Everything else — token, RSC, forwarder —
 *      is the real production bytecode under test.
 */
contract SapuFixture is Test {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 internal constant TRANSFER_TOPIC_0 =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
    uint256 internal constant REACTIVE_IGNORE =
        0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    address payable internal constant CALLBACK_PROXY_PAYABLE = payable(0x476F44b11F5C942c58f4c8E3d0300E5710743585);
    address internal constant CALLBACK_PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;

    address internal owner = makeAddr("sapu-owner");
    address internal coldWallet = makeAddr("cold-wallet");
    address internal burner = makeAddr("burner");
    address internal depositor = makeAddr("depositor");
    address internal attacker = makeAddr("attacker");

    MockSystemContract internal system;
    CallbackProxySimulator internal proxy;
    SapuRSC internal rsc;
    SapuForwarder internal forwarder;
    SweepableERC20 internal token;

    function setUp() public virtual {
        vm.etch(SYSTEM_ADDR, address(new MockSystemContract()).code);
        system = MockSystemContract(payable(SYSTEM_ADDR));

        // The proxy is a distinct address from the system contract, as in production.
        vm.etch(CALLBACK_PROXY, address(new CallbackProxySimulator()).code);
        proxy = CallbackProxySimulator(CALLBACK_PROXY_PAYABLE);

        system.setCallbackProxySimulator(CALLBACK_PROXY);

        token = new SweepableERC20("Sapu Test Token", "SAPU");

        rsc = new SapuRSC(owner, BASE_SEPOLIA_CHAIN_ID);

        forwarder = new SapuForwarder(IPayable(CALLBACK_PROXY_PAYABLE), address(rsc), owner);

        vm.prank(owner);
        rsc.setForwarder(address(forwarder));

        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(token));

        vm.prank(owner);
        forwarder.armRoute(address(token), burner, coldWallet);

        // Burner authorizes the forwarder with a standing allowance, as a real
        // EIP-2612 permit would. Done with vm.prank so no gas is ever sent to it.
        vm.prank(burner);
        token.approve(address(forwarder), type(uint256).max);
    }

    /// @dev Builds the LogRecord the way Reactive Network normalises an ERC-20 Transfer.
    function _transferLog(address from_, address to_, uint256 amount_, address token_)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: BASE_SEPOLIA_CHAIN_ID,
            contractAddress: token_,
            topic0: TRANSFER_TOPIC_0,
            topic1: uint256(uint160(from_)),
            topic2: uint256(uint160(to_)),
            topic3: 0,
            data: abi.encode(amount_),
            blockNumber: block.number,
            opCode: 3,
            blockHash: uint256(keccak256("block")),
            txHash: uint256(keccak256("tx")),
            logIndex: 0
        });
    }

    /// @dev Delivers a log to `react()` as the system contract.
    function _deliver(IReactive.LogRecord memory log_) internal {
        vm.prank(SYSTEM_ADDR);
        rsc.react(log_);
    }

    /// @dev Full loop: mint to burner, deliver the log, then let the proxy simulator
    ///      deliver the recorded callback to the forwarder.
    function _runLoop(uint256 amount_) internal returns (uint256 swept_) {
        token.mint(burner, amount_);
        _deliver(_transferLog(depositor, burner, amount_, address(token)));
        (bool ok,) = proxy.deliver(proxy.pendingCount() - 1);
        assertTrue(ok, "callback delivery failed");
        swept_ = amount_;
    }
}

contract SapuRSCTest is SapuFixture {
    // -------------------------------------------------------------------------
    // registerRoute
    // -------------------------------------------------------------------------

    function test_registerRoute_subscribesWithExactCriteria() public view {
        assertEq(system.subscriptionCount(), 1, "exactly one subscription");

        MockSystemContract.Criteria memory c = system.subscriptionAt(0);
        assertEq(c.chainId, BASE_SEPOLIA_CHAIN_ID, "chainId");
        assertEq(c.contractAddress, address(token), "token");
        assertEq(c.topic0, TRANSFER_TOPIC_0, "topic0 = Transfer");
        assertEq(c.topic1, REACTIVE_IGNORE, "topic1 wildcard (any sender)");
        assertEq(c.topic2, uint256(uint160(burner)), "topic2 = burner");
        assertEq(c.topic3, REACTIVE_IGNORE, "topic3 wildcard");
    }

    function test_registerRoute_storesRoute() public view {
        SapuRSC.Route memory route = rsc.routeOf(address(token), burner);
        assertEq(route.coldWallet, coldWallet);
        assertTrue(route.active);
        assertEq(rsc.tokensOf(burner).length, 1);
        assertEq(rsc.tokensOf(burner)[0], address(token));
    }

    function test_registerRoute_revertsWhenNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        rsc.registerRoute(makeAddr("b2"), coldWallet, address(token));
    }

    function test_registerRoute_revertsOnDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SapuRSC.RouteAlreadyRegistered.selector, burner, address(token)));
        rsc.registerRoute(burner, coldWallet, address(token));
    }

    function test_registerRoute_revertsOnZeroBurner() public {
        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.registerRoute(address(0), coldWallet, address(token));
    }

    function test_registerRoute_revertsOnZeroColdWallet() public {
        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.registerRoute(makeAddr("b3"), address(0), address(token));
    }

    function test_registerRoute_revertsOnZeroToken() public {
        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.registerRoute(makeAddr("b4"), coldWallet, address(0));
    }

    function test_registerRoute_multipleTokensCreateMultipleSubscriptions() public {
        SweepableERC20 second = new SweepableERC20("Second", "TWO");
        vm.prank(owner);
        rsc.registerRoute(burner, coldWallet, address(second));

        assertEq(system.subscriptionCount(), 2);
        assertEq(rsc.tokensOf(burner).length, 2);
    }

    /// @dev `registeredBlock` is a uint64 for a real reason: it is forensic metadata, and
    ///      a silently truncated block number would be worse than no block number. The
    ///      guard is unreachable on any real chain, but "unreachable" is a claim worth
    ///      testing once — `vm.roll` can put the EVM past the boundary.
    function test_registerRoute_revertsWhenBlockNumberExceedsUint64() public {
        vm.roll(uint256(type(uint64).max) + 1);

        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.registerRoute(makeAddr("b-overflow"), coldWallet, address(token));
    }

    // -------------------------------------------------------------------------
    // revokeRoute
    // -------------------------------------------------------------------------

    function test_revokeRoute_unsubscribesAndDeactivates() public {
        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));

        assertFalse(rsc.routeOf(address(token), burner).active);
        assertEq(system.subscriptionCount(), 0, "subscription withdrawn");

        // A deposit after revocation must not produce a callback.
        token.mint(burner, 1e18);
        _deliver(_transferLog(depositor, burner, 1e18, address(token)));
        assertEq(system.callbackCount(), 0);
    }

    function test_revokeRoute_revertsWhenNotArmed() public {
        vm.prank(owner);
        rsc.revokeRoute(burner, address(token));

        // Second revoke: the route is already gone.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SapuRSC.RouteNotRegistered.selector, burner, address(token)));
        rsc.revokeRoute(burner, address(token));
    }

    function test_revokeRoute_revertsWhenNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        rsc.revokeRoute(burner, address(token));
    }

    // -------------------------------------------------------------------------
    // react() — happy path
    // -------------------------------------------------------------------------

    function test_react_emitsCallbackForRegisteredBurner() public {
        token.mint(burner, 5e18);

        vm.expectEmit(true, true, true, true, address(rsc));
        emit SapuRSC.PurgeTriggered(burner, address(token), coldWallet, 5e18, block.number);

        _deliver(_transferLog(depositor, burner, 5e18, address(token)));

        assertEq(system.callbackCount(), 1, "one callback requested");

        MockSystemContract.CallbackRecord memory cb = system.callbackAt(0);
        assertEq(cb.requester, address(rsc));
        assertEq(cb.chainId, BASE_SEPOLIA_CHAIN_ID, "callback targets Base Sepolia");
        assertEq(cb.recipient, address(forwarder), "callback targets forwarder");
        assertEq(cb.gasLimit, 150_000, "spec gas limit");

        // Payload must lead with the address(0) placeholder the proxy overwrites.
        bytes memory expected = abi.encodeWithSignature(
            "executeSweep(address,address,address,address,uint256)",
            address(0),
            address(token),
            burner,
            coldWallet,
            5e18
        );
        assertEq(cb.payload, expected, "payload matches executeSweep signature");
    }

    function test_react_ignoresTransferFromBurner() public {
        // topic2 is the recipient. A transfer *out of* the burner has someone else
        // in topic2, so it must not be treated as a deposit.
        _deliver(_transferLog(burner, attacker, 1e18, address(token)));
        assertEq(system.callbackCount(), 0);
    }

    function test_react_ignoresUnregisteredBurner() public {
        _deliver(_transferLog(depositor, attacker, 1e18, address(token)));
        assertEq(system.callbackCount(), 0);
    }

    function test_react_ignoresOtherToken() public {
        SweepableERC20 other = new SweepableERC20("Other", "OTH");
        // Same burner, but this token has no route: no subscription, no callback.
        _deliver(_transferLog(depositor, burner, 1e18, address(other)));
        assertEq(system.callbackCount(), 0);
    }

    function test_react_ignoresWrongTopic0() public {
        IReactive.LogRecord memory log_ = _transferLog(depositor, burner, 1e18, address(token));
        log_.topic0 = uint256(keccak256("Approval(address,address,uint256)"));
        _deliver(log_);
        assertEq(system.callbackCount(), 0);
    }

    function test_react_ignoresNonLog3Encoding() public {
        // A LOG1 Transfer (unindexed params) carries everything in `data`. The RSC
        // must reject it rather than mis-decode an address as the amount.
        IReactive.LogRecord memory log_ = _transferLog(depositor, burner, 1e18, address(token));
        log_.opCode = 1;
        _deliver(log_);
        assertEq(system.callbackCount(), 0);
    }

    function test_react_ignoresZeroAmount() public {
        _deliver(_transferLog(depositor, burner, 0, address(token)));
        assertEq(system.callbackCount(), 0);
    }

    function test_react_revertsWhenNotSystem() public {
        IReactive.LogRecord memory log_ = _transferLog(depositor, burner, 1e18, address(token));
        vm.prank(attacker);
        vm.expectRevert();
        rsc.react(log_);
    }

    function test_react_revertsWhenForwarderUnset() public {
        SapuRSC fresh = new SapuRSC(owner, BASE_SEPOLIA_CHAIN_ID);
        vm.prank(owner);
        fresh.registerRoute(burner, coldWallet, address(token));

        vm.prank(SYSTEM_ADDR);
        vm.expectRevert(SapuRSC.ForwarderNotSet.selector);
        fresh.react(_transferLog(depositor, burner, 1e18, address(token)));
    }

    function test_react_handlesMultipleDepositsIndependently() public {
        _runLoop(1e18);
        _runLoop(2e18);
        assertEq(system.callbackCount(), 2);
        assertEq(token.balanceOf(coldWallet), 3e18);
    }

    // -------------------------------------------------------------------------
    // react() — fuzz
    // -------------------------------------------------------------------------

    function testFuzz_react_amountRoundTrips(uint256 amount_) public {
        amount_ = bound(amount_, 1, type(uint128).max);
        token.mint(burner, amount_);
        _deliver(_transferLog(depositor, burner, amount_, address(token)));

        MockSystemContract.CallbackRecord memory cb = system.callbackAt(0);
        bytes memory expected =
            abi.encodeWithSignature("executeSweep(address,address,address,address,uint256)", address(0), address(token), burner, coldWallet, amount_);
        assertEq(cb.payload, expected);
    }

    function testFuzz_react_ignoresAnyNonBurnerRecipient(address recipient_) public {
        vm.assume(recipient_ != burner && recipient_ != address(0));
        _deliver(_transferLog(depositor, recipient_, 1e18, address(token)));
        assertEq(system.callbackCount(), 0);
    }

    // -------------------------------------------------------------------------
    // pause / unpause
    // -------------------------------------------------------------------------

    function test_pause_unsubscribesEverything() public {
        vm.prank(owner);
        rsc.pause();

        assertTrue(rsc.paused());
        assertEq(system.subscriptionCount(), 0, "node-side subscription withdrawn");

        // Deliveries during pause are rejected cheaply.
        vm.prank(SYSTEM_ADDR);
        vm.expectRevert(AbstractPausableReactiveContract.ContractPaused.selector);
        rsc.react(_transferLog(depositor, burner, 1e18, address(token)));
    }

    function test_unpause_resubscribesSameCriteria() public {
        vm.prank(owner);
        rsc.pause();
        vm.prank(owner);
        rsc.unpause();

        assertFalse(rsc.paused());
        assertEq(system.subscriptionCount(), 1);

        MockSystemContract.Criteria memory c = system.subscriptionAt(0);
        assertEq(c.topic2, uint256(uint160(burner)), "criteria replay exactly");
        assertEq(c.topic0, TRANSFER_TOPIC_0);
    }

    function test_pause_revertsWhenAlreadyPaused() public {
        vm.prank(owner);
        rsc.pause();
        vm.prank(owner);
        vm.expectRevert(AbstractPausableReactiveContract.ContractPaused.selector);
        rsc.pause();
    }

    function test_unpause_revertsWhenNotPaused() public {
        vm.prank(owner);
        vm.expectRevert(AbstractPausableReactiveContract.ContractNotPaused.selector);
        rsc.unpause();
    }

    function test_pause_revertsWhenNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        rsc.pause();
    }

    function test_registerRouteWhilePausedDefersSubscription() public {
        SweepableERC20 second = new SweepableERC20("Second", "TWO");
        vm.prank(owner);
        rsc.pause();

        vm.prank(owner);
        rsc.registerRoute(makeAddr("b5"), coldWallet, address(second));

        assertEq(system.subscriptionCount(), 0, "no node subscription while paused");

        vm.prank(owner);
        rsc.unpause();
        assertEq(system.subscriptionCount(), 2, "both criteria sets subscribed on resume");
    }

    // -------------------------------------------------------------------------
    // admin + views
    // -------------------------------------------------------------------------

    function test_setForwarder_updatesAndEmits() public {
        address newForwarder = makeAddr("new-forwarder");
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(rsc));
        emit SapuRSC.ForwarderSet(newForwarder);
        rsc.setForwarder(newForwarder);
        assertEq(rsc.sapuForwarder(), newForwarder);
    }

    function test_setForwarder_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.setForwarder(address(0));
    }

    function test_setCallbackGasLimit() public {
        vm.prank(owner);
        rsc.setCallbackGasLimit(300_000);
        assertEq(rsc.callbackGasLimit(), 300_000);

        token.mint(burner, 1e18);
        _deliver(_transferLog(depositor, burner, 1e18, address(token)));
        assertEq(system.callbackAt(0).gasLimit, 300_000);
    }

    function test_setCallbackGasLimit_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        rsc.setCallbackGasLimit(0);
    }

    function test_constructor_revertsOnZeroChainId() public {
        vm.expectRevert(SapuRSC.InvalidArgument.selector);
        new SapuRSC(owner, 0);
    }

    function test_constructor_revertsOnZeroOwner() public {
        // OZ 5.x Ownable rejects address(0) before SAPU's own check is reached.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SapuRSC(address(0), BASE_SEPOLIA_CHAIN_ID);
    }

    function test_subscriptionsViewReturnsAll() public {
        AbstractPausableReactiveContract.Subscription[] memory subs = rsc.subscriptions();
        assertEq(subs.length, 1);
        assertEq(subs[0].topic2, uint256(uint160(burner)));
        assertEq(rsc.subscriptionCount(), 1);
    }

    function test_isSubscriptionActive() public {
        bytes32 id = rsc.subscriptionId(
            AbstractPausableReactiveContract.Subscription({
                chainId: BASE_SEPOLIA_CHAIN_ID,
                contractAddress: address(token),
                topic0: TRANSFER_TOPIC_0,
                topic1: REACTIVE_IGNORE,
                topic2: uint256(uint160(burner)),
                topic3: REACTIVE_IGNORE
            })
        );
        assertTrue(rsc.isSubscriptionActive(id));

        vm.prank(owner);
        rsc.pause();
        assertFalse(rsc.isSubscriptionActive(id));
    }

    function test_coverDebt_settlesOutstandingDebt() public {
        system.setDebt(address(rsc), 1 ether);
        vm.deal(address(rsc), 1 ether);

        rsc.coverDebt();

        assertEq(address(rsc).balance, 0);
        assertEq(system.debt(address(rsc)), 0, "mock zeroes debt on payment");
    }

    function test_receive_acceptsFunding() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool ok,) = address(rsc).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(rsc).balance, 1 ether);
    }
}
