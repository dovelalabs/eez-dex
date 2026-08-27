// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {MockERC20, MockERC20Decimals6, MockFeeOnTransferERC20} from "./MockERC20.sol";

/// @notice TS-1 requires fee-on-transfer and 6-decimal tokens be rejected or
/// handled as specified. These pin the shapes the later suites test against.
contract MockERC20Test is Test {
    function test_ts1_plain_token_transfers_exactly_what_was_asked() public {
        MockERC20 token = new MockERC20("Token", "TKN", 18);
        token.mint(address(this), 100e18);
        assertTrue(token.transfer(address(0xBEEF), 40e18));
        assertEq(token.balanceOf(address(0xBEEF)), 40e18);
        assertEq(token.balanceOf(address(this)), 60e18);
        assertEq(token.totalSupply(), 100e18);
    }

    function test_ts1_transfer_from_spends_the_allowance() public {
        MockERC20 token = new MockERC20("Token", "TKN", 18);
        token.mint(address(0xA11CE), 10e18);
        vm.prank(address(0xA11CE));
        token.approve(address(this), 6e18);
        assertTrue(token.transferFrom(address(0xA11CE), address(this), 4e18));
        assertEq(token.allowance(address(0xA11CE), address(this)), 2e18);
        assertEq(token.balanceOf(address(this)), 4e18);
    }

    /// @dev The escrow invariant (CT-13) is stated on delivered amounts. A
    /// token that delivers less than it was sent breaks it unless the book
    /// measures what actually arrived — this fixture is how that is tested.
    function test_ts1_fee_on_transfer_delivers_less_than_it_was_sent() public {
        MockFeeOnTransferERC20 token = new MockFeeOnTransferERC20("Fee", "FEE", 18, 100);
        token.mint(address(this), 100e18);
        assertTrue(token.transfer(address(0xBEEF), 10e18));
        assertEq(token.balanceOf(address(0xBEEF)), 9.9e18, "1% is burned in flight");
        assertEq(token.balanceOf(address(this)), 90e18, "the sender is still debited in full");
        assertEq(token.totalSupply(), 99.9e18);
    }

    function test_ts1_six_decimal_token_reports_six_decimals() public {
        MockERC20Decimals6 token = new MockERC20Decimals6("USD Coin", "USDC");
        assertEq(token.decimals(), 6);
        token.mint(address(this), 1_000_000);
        assertEq(token.balanceOf(address(this)), 1_000_000, "one token is 1e6 units");
    }
}
