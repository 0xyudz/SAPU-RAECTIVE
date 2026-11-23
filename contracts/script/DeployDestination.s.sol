// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";
import { ReactiveChains } from "./ReactiveChains.sol";

/**
 * @title DeployDestination
 * @notice Deploys the destination half of SAPU: the sweep executor, plus the demo token
 *         unless an existing asset is supplied.
 *
 * @dev Runs on whichever origin/destination chain the RPC points at. It used to be
 *      `DeployBaseSepolia` with the Base Sepolia callback proxy hardcoded, which made
 *      "deploy to another Reactive chain" a source edit. The proxy is now looked up from
 *      `ReactiveChains` using `block.chainid`, so the script either deploys correctly for
 *      the chain it is actually connected to or refuses.
 *
 * @dev The executor needs the `SapuRSC` address at construction (immutable
 *      `_CALLBACK_SENDER`), so this must run *after* the Reactive half.
 *
 * @dev Usage:
 *
 *        forge script script/DeployDestination.s.sol:DeployDestination \
 *          --rpc-url $ORIGIN_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
 *
 *      Required env:
 *        SAPU_RSC_ADDRESS   — from the Reactive Omni deployment
 *        SAPU_OWNER         — operator address (defaults to the broadcaster)
 *        SAPU_TOKEN_ADDRESS — optional; reuse an existing token instead of deploying one
 */
contract DeployDestination is Script {
    function run() external returns (SapuForwarder forwarder_, SweepableERC20 token_) {
        address rscAddress = vm.envAddress("SAPU_RSC_ADDRESS");
        address owner_ = vm.envOr("SAPU_OWNER", msg.sender);

        // Refuses with UnsupportedChain rather than deploying against a guessed proxy.
        address callbackProxy = ReactiveChains.callbackProxy(block.chainid);

        vm.startBroadcast();

        // Reuse an existing asset if one was supplied, otherwise deploy the demo token.
        address existingToken = vm.envOr("SAPU_TOKEN_ADDRESS", address(0));
        if (existingToken == address(0)) {
            token_ = new SweepableERC20("Sapu Demo Token", "SAPU");
        } else {
            token_ = SweepableERC20(existingToken);
        }

        forwarder_ = new SapuForwarder(IPayable(payable(callbackProxy)), rscAddress, owner_);

        vm.stopBroadcast();

        console.log("== SAPU :: destination ==");
        console.log("chainId         ", block.chainid);
        console.log("SapuForwarder   ", address(forwarder_));
        console.log("Token           ", address(token_));
        console.log("CallbackProxy   ", callbackProxy);
        console.log("Authorized RSC  ", rscAddress);
        console.log("Owner           ", owner_);
    }
}
