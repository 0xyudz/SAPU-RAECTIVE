// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { SapuRSC } from "../src/reactive/SapuRSC.sol";
import { ReactiveChains } from "./ReactiveChains.sol";

/**
 * @title DeployReactiveOmni
 * @notice Deploys the reactive watcher on a Reactive chain (mainnet 1597 or Lasna 5318007).
 *
 * @dev Runs FIRST, before `DeployDestination`: `SapuForwarder` immutably stores the RSC
 *      address as its authorized callback sender, so the RSC must already exist. The
 *      forwarder address is supplied afterwards via `RegisterBurner`.
 *
 * @dev `SAPU_ORIGIN_CHAIN_ID` selects which chain's `Transfer` logs to watch, and the script
 *      refuses a pair that mixes mainnet and testnet — a mainnet origin with a Lasna watcher
 *      (or the reverse) can never receive a real callback, and failing at deploy time is far
 *      cheaper than discovering it from a silent no-sweep.
 *
 * @dev The constructor is payable so the contract can be funded at deployment with the
 *      REACT it needs to pay for reactive transactions. A contract with no reserve and no
 *      balance receives nothing.
 *
 * @dev Usage:
 *
 *        SAPU_ORIGIN_CHAIN_ID=84532 \
 *        forge script script/DeployReactiveOmni.s.sol:DeployReactiveOmni \
 *          --rpc-url $REACTIVE_RPC_URL --broadcast --private-key $REACTIVE_PRIVATE_KEY
 *
 *        cast send $SAPU_RSC_ADDRESS --value 0.05ether \
 *          --rpc-url $REACTIVE_RPC_URL --private-key $REACTIVE_PRIVATE_KEY
 *
 *      Required env:
 *        SAPU_OWNER           — operator address (defaults to the broadcaster)
 *        SAPU_ORIGIN_CHAIN_ID — chain whose deposits are watched (default 84532)
 */
contract DeployReactiveOmni is Script {
    function run() external returns (SapuRSC rsc_) {
        address owner_ = vm.envOr("SAPU_OWNER", msg.sender);
        uint256 originChainId = vm.envOr("SAPU_ORIGIN_CHAIN_ID", ReactiveChains.BASE_SEPOLIA);

        // Both checks are about refusing to deploy something that cannot work.
        if (ReactiveChains.isReactive(originChainId)) {
            revert(
                "SAPU_ORIGIN_CHAIN_ID must be a token chain, not a Reactive chain: SAPU watches ERC-20 transfers on the origin."
            );
        }
        // A mismatched pair is the failure this guard exists for: the node will deliver
        // callbacks across networks only when origin and Reactive are on the same network.
        if (ReactiveChains.isMainnet(originChainId) != ReactiveChains.isMainnet(block.chainid)) {
            revert(
                "Origin and Reactive chain are on different networks (mainnet vs testnet). A callback cannot cross that boundary; set SAPU_ORIGIN_CHAIN_ID to a chain on the same network as the RPC you are deploying to."
            );
        }

        vm.startBroadcast();
        rsc_ = new SapuRSC(owner_, originChainId);
        vm.stopBroadcast();

        console.log("== SAPU :: Reactive ==");
        console.log("chainId         ", block.chainid);
        console.log("SapuRSC         ", address(rsc_));
        console.log("Origin chainId  ", originChainId);
        console.log("Owner           ", owner_);
        console.log("");
        console.log("Next: export SAPU_RSC_ADDRESS=%s and run DeployDestination", address(rsc_));
    }
}
