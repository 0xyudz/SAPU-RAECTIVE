// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";

/**
 * @title DeployReactiveOmni
 * @notice Deploys the reactive watcher on Reactive Lasna (5318007).
 *
 * @dev Runs FIRST, before `DeployBaseSepolia`: `SapuForwarder` immutably stores the
 *      RSC address as its authorized callback sender, so the RSC must already exist.
 *      The forwarder address is supplied afterwards via `RegisterBurner`.
 *
 * @dev The constructor is payable so the contract can be funded at deployment with
 *      the REACT it needs to pay for reactive transactions. A contract with no
 *      reserve and no balance receives nothing.
 *
 * @dev Usage:
 *
 *        forge script script/DeployReactiveOmni.s.sol:DeployReactiveOmni \
 *          --rpc-url $REACTIVE_RPC_URL --broadcast --private-key $REACTIVE_PRIVATE_KEY
 *
 *        cast send $SAPU_RSC_ADDRESS --value 0.05ether \
 *          --rpc-url $REACTIVE_RPC_URL --private-key $REACTIVE_PRIVATE_KEY
 *
 *      Required env:
 *        SAPU_OWNER — operator address (defaults to the broadcaster)
 */
contract DeployReactiveOmni is Script {
    /// @notice Base Sepolia chain id: the origin of the deposits being watched.
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    function run() external returns (SapuRSC rsc_) {
        address owner_ = vm.envOr("SAPU_OWNER", msg.sender);

        vm.startBroadcast();
        rsc_ = new SapuRSC(owner_, BASE_SEPOLIA_CHAIN_ID);
        vm.stopBroadcast();

        console.log("== SAPU :: Reactive Lasna ==");
        console.log("chainId         ", block.chainid);
        console.log("SapuRSC         ", address(rsc_));
        console.log("Origin chainId  ", BASE_SEPOLIA_CHAIN_ID);
        console.log("Owner           ", owner_);
        console.log("");
        console.log("Next: export SAPU_RSC_ADDRESS=%s and run DeployBaseSepolia", address(rsc_));
    }
}
