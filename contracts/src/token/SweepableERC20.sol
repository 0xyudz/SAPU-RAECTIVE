// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title SweepableERC20
 * @notice EIP-2612 permit-capable ERC-20 used as the origin asset for SAPU on
 *         whichever chain it is deployed to. Deliberately boring: the only
 *         non-standard surface is an open `mint`, so a demo can create the deposit
 *         that starts the loop.
 *
 * @dev The open `mint` is intentional and demo-only. It is not a defect to be fixed:
 *      the production requirement is that SAPU can sweep *any* ERC-20 on any
 *      Reactive-supported chain, not that this particular demo token be scarce.
 *
 * @dev EIP-2612 is what makes SAPU truly gasless from the burner's side. A plain
 *      `approve` would require the burner to hold native gas — exactly the link
 *      SAPU exists to avoid. Instead the burner signs a permit off-chain (free),
 *      a relayer submits it, and `SapuForwarder` gains a standing allowance.
 *      See docs/LIMITATIONS.md for the tradeoffs against the allowance path.
 */
contract SweepableERC20 is ERC20, ERC20Permit {
    /// @notice Emitted when the demo faucet mints tokens.
    event Minted(address indexed to, uint256 amount);

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) { }

    /// @notice Mints tokens to any address. Intentionally unrestricted: this is a
    ///         test asset on a testnet and a permissioned mint would make the
    ///         e2e demo require a second funded key.
    /// @param to_ Recipient.
    /// @param amount_ Amount in base units.
    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
        emit Minted(to_, amount_);
    }

    /// @notice Convenience alias so demo scripts read naturally.
    function faucet(uint256 amount_) external {
        _mint(msg.sender, amount_);
        emit Minted(msg.sender, amount_);
    }
}
