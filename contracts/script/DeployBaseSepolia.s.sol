// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";

/**
 * @title DeployBaseSepolia
 * @notice Deploys the Base Sepolia half of SAPU: the test asset and the sweep
 *         executor. The executor needs the `SapuRSC` address at construction
 *         (immutable `_CALLBACK_SENDER`), so this script must run *after*
 *         `DeployReactiveOmni.s.sol`.
 *
 * @dev Usage:
 *
 *        forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
 *          --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
 *
 *      Required env:
 *        SAPU_RSC_ADDRESS   — from the Reactive Omni deployment
 *        SAPU_OWNER         — operator address (defaults to the broadcaster)
 *        SAPU_TOKEN_ADDRESS — optional; reuse an existing token instead of deploying one
 */
contract DeployBaseSepolia is Script {
    /// @notice Base Sepolia callback proxy. Callbacks are billed through this address.
    /// @dev Source: https://dev.reactive.network/origins-and-destinations
    address internal constant CALLBACK_PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;

    function run() external returns (SapuForwarder forwarder_, SweepableERC20 token_) {
        address rscAddress = vm.envAddress("SAPU_RSC_ADDRESS");
        address owner_ = vm.envOr("SAPU_OWNER", msg.sender);

        vm.startBroadcast();

        // Reuse an existing asset if one was supplied, otherwise deploy the demo token.
        address existingToken = vm.envOr("SAPU_TOKEN_ADDRESS", address(0));
        if (existingToken == address(0)) {
            token_ = new SweepableERC20("Sapu Demo Token", "SAPU");
        } else {
            token_ = SweepableERC20(existingToken);
        }

        forwarder_ = new SapuForwarder(IPayable(payable(CALLBACK_PROXY)), rscAddress, owner_);

        vm.stopBroadcast();

        console.log("== SAPU :: Base Sepolia ==");
        console.log("chainId         ", block.chainid);
        console.log("SapuForwarder   ", address(forwarder_));
        console.log("Token           ", address(token_));
        console.log("CallbackProxy   ", CALLBACK_PROXY);
        console.log("Authorized RSC  ", rscAddress);
        console.log("Owner           ", owner_);
    }
}
