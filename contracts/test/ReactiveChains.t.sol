// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { ReactiveChains } from "../script/ReactiveChains.sol";

/**
 * @notice Pins the deployment script chain table to the official Reactive docs.
 *
 * @dev A wrong callback proxy is invisible until a real callback is delivered and the
 *      forwarder's `onlyServiceProvider` rejects it — by which point the deployment is
 *      live and the failure looks like a contract bug rather than a typo. These tests
 *      turn that silent misconfiguration into a red build.
 *
 *      The expected values are copied from
 *      https://dev.reactive.network/origins-and-destinations independently of the
 *      library, so editing `ReactiveChains` alone cannot make this pass.
 */
contract ReactiveChainsTest is Test {
    function test_callbackProxy_matchesOfficialTable() public pure {
        assertEq(ReactiveChains.callbackProxy(1), 0xFCE1F192F489c988392aBC16E91e359d540d94Fe, "Ethereum");
        assertEq(ReactiveChains.callbackProxy(56), 0xfc41eE9d3A836b41399BEcce83b06B3e5650f3BB, "BSC");
        assertEq(ReactiveChains.callbackProxy(130), 0x754120EC7a6eF81E4c5c835AA603C63Da64693E6, "Unichain");
        assertEq(ReactiveChains.callbackProxy(999), 0x754120EC7a6eF81E4c5c835AA603C63Da64693E6, "HyperEVM");
        assertEq(ReactiveChains.callbackProxy(1597), ReactiveChains.SYSTEM_CONTRACT, "Reactive mainnet");
        assertEq(ReactiveChains.callbackProxy(4663), 0x476F44b11F5C942c58f4c8E3d0300E5710743585, "Robinhood");
        assertEq(ReactiveChains.callbackProxy(8453), 0xCc780DdE33f56f55dE778D42c930959374a4a068, "Base");
        assertEq(ReactiveChains.callbackProxy(42161), 0xaee8d2deBaB5bE353bfec167C58a549923892e11, "Arbitrum");
        assertEq(ReactiveChains.callbackProxy(43114), 0x8bdfC7e564B90b31c49Cf1079d4c44400F4e14B4, "Avalanche");
        assertEq(ReactiveChains.callbackProxy(1301), 0x775c9B990ADe401060B78D0e98684eEf8d2466C1, "Unichain Sepolia");
        assertEq(ReactiveChains.callbackProxy(5318007), ReactiveChains.SYSTEM_CONTRACT, "Reactive Lasna");
        assertEq(ReactiveChains.callbackProxy(84532), 0x476F44b11F5C942c58f4c8E3d0300E5710743585, "Base Sepolia");
        assertEq(ReactiveChains.callbackProxy(11155111), 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4, "Ethereum Sepolia");
    }

    /// An unlisted chain must revert rather than silently receive a guessed proxy.
    function test_callbackProxy_revertsForUnsupportedChain() public {
        vm.expectRevert(abi.encodeWithSelector(ReactiveChains.UnsupportedChain.selector, uint256(999999)));
        this.callbackProxyExternal(999999);
    }

    function callbackProxyExternal(uint256 chainId_) external pure returns (address) {
        return ReactiveChains.callbackProxy(chainId_);
    }

    function test_isReactive_onlyForReactiveChains() public pure {
        assertTrue(ReactiveChains.isReactive(1597));
        assertTrue(ReactiveChains.isReactive(5318007));
        assertFalse(ReactiveChains.isReactive(84532));
        assertFalse(ReactiveChains.isReactive(8453));
    }

    /// The mainnet/testnet split is what stops a deploy script from pairing a mainnet
    /// origin with a Lasna watcher, which could never receive a real callback.
    function test_isMainnet_separatesTheTwoNetworks() public pure {
        assertTrue(ReactiveChains.isMainnet(1));
        assertTrue(ReactiveChains.isMainnet(8453));
        assertTrue(ReactiveChains.isMainnet(1597));
        assertFalse(ReactiveChains.isMainnet(84532));
        assertFalse(ReactiveChains.isMainnet(11155111));
        assertFalse(ReactiveChains.isMainnet(1301));
        assertFalse(ReactiveChains.isMainnet(5318007));
    }
}
