// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { SweepableERC20 } from "../src/token/SweepableERC20.sol";

contract SweepableERC20Test is Test {
    SweepableERC20 internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new SweepableERC20("Sapu Test Token", "SAPU");
    }

    function test_metadata() public view {
        assertEq(token.name(), "Sapu Test Token");
        assertEq(token.symbol(), "SAPU");
        assertEq(token.decimals(), 18);
    }

    function test_mint_creditsRecipientAndEmits() public {
        vm.expectEmit(true, true, true, true, address(token));
        emit SweepableERC20.Minted(alice, 5e18);
        token.mint(alice, 5e18);
        assertEq(token.balanceOf(alice), 5e18);
    }

    function test_faucet_mintsToCaller() public {
        vm.prank(alice);
        token.faucet(7e18);
        assertEq(token.balanceOf(alice), 7e18);
    }

    function test_supportsEip2612Permit() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("signer");
        uint256 value = 42e18;
        uint256 deadline = block.timestamp + 1 days;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer,
                bob,
                value,
                token.nonces(signer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        token.permit(signer, bob, value, deadline, v, r, s);

        assertEq(token.allowance(signer, bob), value);
        assertEq(token.nonces(signer), 1);
    }

    function test_permit_revertsAfterDeadline() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("signer2");
        uint256 deadline = block.timestamp - 1;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer,
                bob,
                1e18,
                token.nonces(signer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        vm.expectRevert();
        token.permit(signer, bob, 1e18, deadline, v, r, s);
    }

    function test_transfer_movesBalance() public {
        token.mint(alice, 3e18);
        vm.prank(alice);
        token.transfer(bob, 1e18);
        assertEq(token.balanceOf(alice), 2e18);
        assertEq(token.balanceOf(bob), 1e18);
    }

    function testFuzz_mintAndTransfer(uint96 amount_) public {
        uint256 amount = uint256(amount_);
        token.mint(alice, amount);
        vm.prank(alice);
        token.transfer(bob, amount);
        assertEq(token.balanceOf(bob), amount);
        assertEq(token.balanceOf(alice), 0);
    }
}
