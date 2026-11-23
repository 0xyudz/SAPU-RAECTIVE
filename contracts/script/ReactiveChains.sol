// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title ReactiveChains
 * @notice The Reactive Network origin/destination table, for deployment scripts.
 *
 * @dev ## Why this exists
 *
 *      The deploy scripts used to hardcode Base Sepolia's callback proxy and chain id.
 *      A wrong callback proxy is not a small mistake: `AbstractCallback` compares
 *      `msg.sender` against it, so a forwarder deployed with another chain's proxy
 *      rejects every real callback and there is no on-chain signal explaining why.
 *
 *      Keeping the table in one place means a script asks "what is the proxy for the
 *      chain I am deploying to?" instead of assuming, and a new chain is one entry.
 *
 * @dev Source: https://dev.reactive.network/origins-and-destinations
 *
 *      Transcribed values only. Nothing here is derived or guessed, and the scripts
 *      refuse to run when the target chain is not in the table — an unrecognised chain
 *      must fail loudly rather than silently receive a made-up proxy.
 */
library ReactiveChains {
    /// @notice Reactive's own system contract; identical on mainnet and Lasna.
    address internal constant SYSTEM_CONTRACT = 0x8888888888888888888888888888888888888888;

    // -------------------------------------------------------------------------
    // Mainnet
    // -------------------------------------------------------------------------

    uint256 internal constant ETHEREUM = 1;
    uint256 internal constant BSC = 56;
    uint256 internal constant UNICHAIN = 130;
    uint256 internal constant HYPEREVM = 999;
    uint256 internal constant REACTIVE_MAINNET = 1597;
    uint256 internal constant ROBINHOOD = 4663;
    uint256 internal constant BASE = 8453;
    uint256 internal constant ARBITRUM = 42161;
    uint256 internal constant AVALANCHE = 43114;

    // -------------------------------------------------------------------------
    // Testnet
    // -------------------------------------------------------------------------

    uint256 internal constant UNICHAIN_SEPOLIA = 1301;
    uint256 internal constant REACTIVE_LASNA = 5318007;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant ETHEREUM_SEPOLIA = 11155111;

    /// @notice Thrown when a script is pointed at a chain Reactive does not list.
    error UnsupportedChain(uint256 chainId);

    /// @notice The callback proxy for a chain, or a revert when the chain is not listed.
    /// @dev Every value is the address published in the official table. The two Reactive
    ///      chains use the system contract, which is how reactive contracts are invoked.
    function callbackProxy(uint256 chainId) internal pure returns (address) {
        if (chainId == ETHEREUM) return 0xFCE1F192F489c988392aBC16E91e359d540d94Fe;
        if (chainId == BSC) return 0xfc41eE9d3A836b41399BEcce83b06B3e5650f3BB;
        if (chainId == UNICHAIN) return 0x754120EC7a6eF81E4c5c835AA603C63Da64693E6;
        if (chainId == HYPEREVM) return 0x754120EC7a6eF81E4c5c835AA603C63Da64693E6;
        if (chainId == REACTIVE_MAINNET) return SYSTEM_CONTRACT;
        if (chainId == ROBINHOOD) return 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
        if (chainId == BASE) return 0xCc780DdE33f56f55dE778D42c930959374a4a068;
        if (chainId == ARBITRUM) return 0xaee8d2deBaB5bE353bfec167C58a549923892e11;
        if (chainId == AVALANCHE) return 0x8bdfC7e564B90b31c49Cf1079d4c44400F4e14B4;
        if (chainId == UNICHAIN_SEPOLIA) return 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
        if (chainId == REACTIVE_LASNA) return SYSTEM_CONTRACT;
        if (chainId == BASE_SEPOLIA) return 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
        if (chainId == ETHEREUM_SEPOLIA) return 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4;
        revert UnsupportedChain(chainId);
    }

    /// @notice Whether this chain is a Reactive chain (where reactive contracts execute).
    function isReactive(uint256 chainId) internal pure returns (bool) {
        return chainId == REACTIVE_MAINNET || chainId == REACTIVE_LASNA;
    }

    /// @notice Whether this chain is a mainnet chain, i.e. not one of the two testnets.
    /// @dev Used to refuse a mainnet/testnet mix: a mainnet origin with a testnet
    ///      destination cannot receive a real callback.
    function isMainnet(uint256 chainId) internal pure returns (bool) {
        return chainId != REACTIVE_LASNA && chainId != BASE_SEPOLIA && chainId != ETHEREUM_SEPOLIA
            && chainId != UNICHAIN_SEPOLIA;
    }
}
