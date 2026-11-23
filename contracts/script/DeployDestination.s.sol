// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuForwarder } from "../src/destination/SapuForwarder.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";
import { IPayable } from "@reactive/interfaces/IPayable.sol";
import { ReactiveChains } from "./ReactiveChains.sol";

/**
 * @title DeployDestination
 * @notice Deploys the destination half of SAPU: the sweep executor, and nothing else
 *         unless no asset was supplied.
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
 * @dev SAPU does not need its own token. Any ERC-20 on a Reactive-supported chain works,
 *      so `SAPU_TOKEN_ADDRESS` is the normal path and the demo token is a fallback for a
 *      local anvil run. The deployed token is reported separately from the asset the
 *      forwarder will actually sweep, because those are the same thing only when SAPU
 *      deployed the token itself.
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
    function run() external returns (SapuForwarder forwarder_, address token_) {
        address rscAddress = vm.envAddress("SAPU_RSC_ADDRESS");
        address owner_ = vm.envOr("SAPU_OWNER", msg.sender);

        // Refuses with UnsupportedChain rather than deploying against a guessed proxy.
        address callbackProxy = ReactiveChains.callbackProxy(block.chainid);

        // Reuse an existing asset if one was supplied, otherwise deploy the demo token.
        address existingToken = vm.envOr("SAPU_TOKEN_ADDRESS", address(0));

        vm.startBroadcast();

        if (existingToken == address(0)) {
            token_ = address(new SweepableERC20("Sapu Demo Token", "SAPU"));
        } else {
            // Deliberately not cast to `SweepableERC20`: the supplied asset is an arbitrary
            // ERC-20, not SAPU's demo token, and narrowing the type would invite a later
            // `mint()` call that a real token does not have.
            token_ = existingToken;
        }

        forwarder_ = new SapuForwarder(IPayable(payable(callbackProxy)), rscAddress, owner_);

        vm.stopBroadcast();

        console.log("== SAPU :: destination ==");
        console.log("chainId         ", block.chainid);
        console.log("SapuForwarder   ", address(forwarder_));
        console.log("Token           ", token_);
        console.log("Token supplied  ", existingToken != address(0));
        console.log("CallbackProxy   ", callbackProxy);
        console.log("Authorized RSC  ", rscAddress);
        console.log("Owner           ", owner_);
    }
}
