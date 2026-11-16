// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";

/**
 * @title RegisterBurner
 * @notice Arms a burner route on both sides of the loop.
 *
 * @dev This is the "set it" half of "set it and forget it". It performs three steps
 *      that must all succeed, in this order:
 *
 *        1. `SapuRSC.setForwarder`      — tell the watcher where to send callbacks.
 *        2. `SapuRSC.registerRoute`     — subscribe to deposits into the burner.
 *        3. `SapuForwarder.armRoute`    — arm the destination-side rule.
 *
 *      Steps 2 and 3 both matter. If only the RSC side is armed, the callback fires
 *      and reverts with `RouteNotArmed`; if only the forwarder side is armed, no
 *      subscription exists and nothing is ever triggered.
 *
 * @dev The two contracts live on different chains, so this script is split in two
 *      entry points. `--sig` selects which half to run.
 *
 *      Reactive side (Lasna):
 *        forge script script/RegisterBurner.s.sol:RegisterBurner \
 *          --sig "registerReactive(address,address,address,address)" $RSC $FORWARDER $BURNER $TOKEN \
 *          --rpc-url $REACTIVE_RPC_URL --broadcast --private-key $REACTIVE_PRIVATE_KEY
 *
 *      Destination side (Base Sepolia):
 *        forge script script/RegisterBurner.s.sol:RegisterBurner \
 *          --sig "armForwarder(address,address,address,address)" $FWD $BURNER $COLD $TOKEN \
 *          --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
 *
 *      Required env:
 *        SAPU_COLD_WALLET — destination for swept funds (read by `registerReactive`).
 */
contract RegisterBurner is Script {
    /// @notice Configures the RSC: sets the forwarder and subscribes to the burner.
    /// @param rsc_ SapuRSC address on Lasna.
    /// @param forwarder_ SapuForwarder address on Base Sepolia.
    /// @param burner_ Burner address to watch.
    /// @param token_ ERC-20 to watch.
    function registerReactive(address rsc_, address forwarder_, address burner_, address token_) external {
        SapuRSC rsc = SapuRSC(payable(rsc_));

        vm.startBroadcast();
        rsc.setForwarder(forwarder_);
        rsc.registerRoute(burner_, vm.envAddress("SAPU_COLD_WALLET"), token_);
        vm.stopBroadcast();

        console.log("== SAPU :: route armed on Reactive ==");
        console.log("SapuRSC      ", rsc_);
        console.log("Forwarder    ", forwarder_);
        console.log("Burner       ", burner_);
        console.log("Token        ", token_);
    }

    /// @notice Arms the destination-side rule.
    /// @param forwarder_ SapuForwarder address on Base Sepolia.
    /// @param burner_ Burner address.
    /// @param coldWallet_ Destination for swept funds.
    /// @param token_ ERC-20 to sweep.
    function armForwarder(address forwarder_, address burner_, address coldWallet_, address token_) external {
        vm.startBroadcast();
        SapuForwarder(payable(forwarder_)).armRoute(token_, burner_, coldWallet_);
        vm.stopBroadcast();

        console.log("== SAPU :: rule armed on Base Sepolia ==");
        console.log("SapuForwarder", forwarder_);
        console.log("Burner       ", burner_);
        console.log("ColdWallet   ", coldWallet_);
        console.log("Token        ", token_);
    }
}
