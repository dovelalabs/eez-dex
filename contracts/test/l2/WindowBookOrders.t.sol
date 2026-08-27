// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MockERC20, MockERC20Decimals6, MockFeeOnTransferERC20} from "../mocks/MockERC20.sol";
import {Mirror} from "../../src/l2/Mirror.sol";
import {BookConfig, FeeMode, OrderStatus, WindowBook} from "../../src/l2/WindowBook.sol";
import {Order, Side} from "../../src/types/Types.sol";
import {WindowBookFixture} from "./WindowBookFixture.sol";

/// @notice TS-1 — book escrow and cancellation, the quote views, and `latestPrice`.
/// @dev CT-7 (place, cancel, reclaim, withdraw), CT-8 (quote), CT-14 (`latestPrice`),
/// EC-6 (window length) and the token shapes TS-1 requires be rejected or handled.
contract WindowBookOrdersTest is WindowBookFixture {
    // ------------------------------------------------------- CT-7 · placing ------

    function test_ct7_place_escrows_and_derives_the_id_on_chain() public {
        uint256 sellAmount = 10e18;
        _fund(alice, tokenA, sellAmount);

        vm.prank(alice);
        bytes32 id = book.place(_order(alice, Side.SELL_A_FOR_B, sellAmount, 19_000e18));

        assertEq(id, keccak256(abi.encodePacked(alice, uint256(0))), "CT-7: id is keccak256(owner, nonce)");
        assertEq(uint8(book.statusOf(id)), uint8(OrderStatus.OPEN), "order is open");
        assertEq(book.escrowed(address(tokenA)), sellAmount, "escrow taken");
        assertEq(tokenA.balanceOf(address(book)), sellAmount, "tokens held");
        assertEq(book.openOrderCount(), 1, "in the open window");
        assertEq(book.nonces(alice), 1, "nonce advanced");
        _assertEscrowInvariant();
    }

    /// @dev The id is derived, so a caller cannot choose it — nor collide with someone
    /// else's by supplying one (CT-7).
    function test_ct7_supplied_id_and_owner_are_ignored() public {
        _fund(alice, tokenA, 1e18);
        Order memory o = _order(alice, Side.SELL_A_FOR_B, 1e18, 0);
        o.id = keccak256("i would like this id please");
        o.owner = bob;

        vm.prank(alice);
        bytes32 id = book.place(o);

        assertEq(id, keccak256(abi.encodePacked(alice, uint256(0))), "id derived from the caller");
        assertEq(book.orderOf(id).owner, alice, "owner is the caller");
    }

    function test_ct7_each_order_gets_its_own_id() public {
        bytes32 first = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        bytes32 second = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        assertTrue(first != second, "nonce makes ids unique");
        assertEq(book.escrowed(address(tokenA)), 2e18, "both escrowed");
    }

    function test_ct7_place_rejects_a_zero_sell_amount_or_recipient() public {
        _fund(alice, tokenA, 1e18);

        vm.prank(alice);
        vm.expectRevert(WindowBook.InvalidOrder.selector);
        book.place(_order(alice, Side.SELL_A_FOR_B, 0, 0));

        Order memory o = _order(alice, Side.SELL_A_FOR_B, 1e18, 0);
        o.recipient = address(0);
        vm.prank(alice);
        vm.expectRevert(WindowBook.InvalidOrder.selector);
        book.place(o);
    }

    function test_ct7_place_rejects_value_alongside_an_erc20_sell() public {
        _fund(alice, tokenA, 1e18);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(WindowBook.ValueMismatch.selector);
        book.place{value: 1}(_order(alice, Side.SELL_A_FOR_B, 1e18, 0));
    }

    /// @dev **[full]** an ETH leg escrows the call's `value`; **[genesis]** it is the
    /// only leg there is (FL-3).
    function test_ct7_place_escrows_native_eth_as_value() public {
        _deployEthPair();

        bytes32 id = _placeEth(alice, Side.SELL_A_FOR_B, 1e18, 0);

        assertEq(book.escrowed(address(0)), 1e18, "ETH escrowed");
        assertEq(address(book).balance, 1e18, "ETH held");
        assertEq(uint8(book.statusOf(id)), uint8(OrderStatus.OPEN));
        _assertEscrowInvariant();
    }

    function test_ct7_place_rejects_a_value_that_is_not_the_sell_amount() public {
        _deployEthPair();
        vm.deal(alice, 5e18);
        vm.prank(alice);
        vm.expectRevert(WindowBook.ValueMismatch.selector);
        book.place{value: 0.5e18}(_order(alice, Side.SELL_A_FOR_B, 1e18, 0));
    }

    /// @dev TS-1: a token whose `transferFrom` delivers less than it was asked for is
    /// **rejected**, not accounted for. Measuring the delivered amount instead would
    /// leave every downstream number — netting, band, limits — quoting an escrow the
    /// book does not hold (CT-13).
    function test_ts1_fee_on_transfer_tokens_are_rejected() public {
        MockFeeOnTransferERC20 skimmed = new MockFeeOnTransferERC20("Skim", "SKIM", 18, 100);
        BookConfig memory cfg = _defaultConfig();
        cfg.assetA = address(skimmed);
        _deploy(cfg);

        skimmed.mint(alice, 10e18);
        vm.prank(alice);
        skimmed.approve(address(book), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(WindowBook.FeeOnTransferToken.selector);
        book.place(_order(alice, Side.SELL_A_FOR_B, 10e18, 0));
    }

    /// @dev TS-1: six decimals are **handled**, not rejected — Q96 price arithmetic is
    /// decimal-agnostic and the only consequence is that a wei of dust is worth 10**12
    /// times more, which rounding down already assigns to the fee bucket (CT-12).
    function test_ts1_six_decimal_tokens_are_handled() public {
        MockERC20Decimals6 usdc = new MockERC20Decimals6("USD Coin", "USDC");
        BookConfig memory cfg = _defaultConfig();
        cfg.assetB = address(usdc);
        _deploy(cfg);

        usdc.mint(bob, 2000e6);
        vm.prank(bob);
        usdc.approve(address(book), type(uint256).max);

        vm.prank(bob);
        bytes32 id = book.place(_order(bob, Side.SELL_B_FOR_A, 2000e6, 0));

        assertEq(book.escrowed(address(usdc)), 2000e6, "escrow in the token's own units");
        assertEq(uint8(book.statusOf(id)), uint8(OrderStatus.OPEN));
        assertEq(book.escrowInvariantDrift(address(usdc)), 0, "CT-13 holds at six decimals");
    }

    function test_ct7_place_rejects_an_order_the_fee_would_consume() public {
        BookConfig memory cfg = _defaultConfig();
        cfg.feeMode = FeeMode.FIXED;
        cfg.feeFixedA = 1e18;
        _deploy(cfg);

        _fund(alice, tokenA, 1e18);
        vm.prank(alice);
        vm.expectRevert(WindowBook.InvalidOrder.selector);
        book.place(_order(alice, Side.SELL_A_FOR_B, 1e18, 0));
    }

    // ------------------------------------------------------ CT-7 · cancelling ----

    function test_ct7_cancel_releases_escrow_to_the_owner() public {
        bytes32 id = _place(alice, Side.SELL_A_FOR_B, 10e18, 0);
        uint256 before = tokenA.balanceOf(alice);

        vm.prank(alice);
        book.cancel(id);

        assertEq(uint8(book.statusOf(id)), uint8(OrderStatus.CANCELLED), "cancelled");
        assertEq(tokenA.balanceOf(alice) - before, 10e18, "escrow returned");
        assertEq(book.escrowed(address(tokenA)), 0, "escrow cleared");
        assertEq(book.openOrderCount(), 0, "out of the open window");
        _assertEscrowInvariant();
    }

    function test_ct7_cancel_is_owner_only_and_open_only() public {
        bytes32 id = _place(alice, Side.SELL_A_FOR_B, 10e18, 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WindowBook.NotOrderOwner.selector, id));
        book.cancel(id);

        vm.prank(alice);
        book.cancel(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WindowBook.OrderNotOpen.selector, id));
        book.cancel(id);
    }

    // -------------------------------------------------------- CT-7 · reclaiming --

    /// @dev The settlement sweep is bounded, so `reclaim` is the path that has no bound:
    /// anyone may call it, for any expired order, however deep in the book (CT-7). Here
    /// 65 orders expire at one boundary and the sweep's 64-entry scan leaves the oldest.
    function test_ct7_reclaim_releases_an_expired_order_the_sweep_did_not_reach() public {
        bytes32 oldest = _placeExpiring(alice, Side.SELL_A_FOR_B, 10e18, 0, 0);
        for (uint256 i = 0; i < 64; ++i) {
            _placeExpiring(bob, Side.SELL_A_FOR_B, 1e18, 0, 0);
        }
        bytes32 fresh = _place(carol, Side.SELL_A_FOR_B, 1e18, 0);

        // One settlement advances the window past every stale order's expiry.
        _settle(_ids(fresh));
        assertEq(book.windowId(), 1, "window advanced");
        assertEq(uint8(book.statusOf(oldest)), uint8(OrderStatus.OPEN), "beyond the sweep's reach");

        uint256 before = tokenA.balanceOf(alice);
        vm.prank(dave); // anyone
        book.reclaim(oldest);

        assertEq(uint8(book.statusOf(oldest)), uint8(OrderStatus.EXPIRED), "expired");
        assertEq(tokenA.balanceOf(alice) - before, 10e18, "escrow returned to the owner");
        assertEq(book.openOrderCount(), 0, "the book is empty again");
        _assertEscrowInvariant();
    }

    /// @dev CT-9's sweep, at the boundary: escrow becomes an L2 balance without the
    /// settlement ever calling out to an order owner.
    function test_ct9_settlement_sweeps_expired_orders() public {
        bytes32 stale = _placeExpiring(alice, Side.SELL_A_FOR_B, 10e18, 0, 0);
        bytes32 fresh = _place(bob, Side.SELL_A_FOR_B, 1e18, 0);

        _settle(_ids(fresh));

        assertEq(uint8(book.statusOf(stale)), uint8(OrderStatus.EXPIRED), "swept");
        assertEq(book.balanceOf(address(tokenA), alice), 10e18, "credited to the owner");
        assertEq(book.openOrderCount(), 0, "out of the open window");
        _assertEscrowInvariant();
    }

    function test_ct7_reclaim_rejects_an_order_that_has_not_expired() public {
        bytes32 id = _place(alice, Side.SELL_A_FOR_B, 10e18, 0);
        vm.expectRevert(abi.encodeWithSelector(WindowBook.OrderNotExpired.selector, id));
        book.reclaim(id);
    }

    // ------------------------------------------------------- CT-7 · withdrawing --

    function test_ct7_withdraw_moves_an_l2_balance_out() public {
        // The sweep credits an expired order's escrow to its owner's L2 balance.
        bytes32 stale = _placeExpiring(alice, Side.SELL_A_FOR_B, 10e18, 0, 0);
        bytes32 fresh = _place(bob, Side.SELL_A_FOR_B, 1e18, 0);
        _settle(_ids(fresh));

        assertEq(uint8(book.statusOf(stale)), uint8(OrderStatus.EXPIRED), "swept at the boundary");
        assertEq(book.balanceOf(address(tokenA), alice), 10e18, "credited, not called out to");

        uint256 before = tokenA.balanceOf(alice);
        vm.prank(alice);
        book.withdraw(address(tokenA), 4e18);

        assertEq(tokenA.balanceOf(alice) - before, 4e18, "withdrawn");
        assertEq(book.balanceOf(address(tokenA), alice), 6e18, "the rest stays");
        _assertEscrowInvariant();
    }

    function test_ct7_withdraw_rejects_more_than_the_balance() public {
        vm.prank(alice);
        vm.expectRevert(WindowBook.InsufficientBalance.selector);
        book.withdraw(address(tokenA), 1);
    }

    // -------------------------------------------------------------- CT-8 · quote --

    function test_ct8_quote_reads_the_mirror() public view {
        (uint256 amountOut, uint32 ageSlots, uint32 blocksLeft) = book.quote(1e18, Side.SELL_A_FOR_B);

        assertEq(amountOut, Mirror.quote(_poolState(PRICE_X96), 1e18, Side.SELL_A_FOR_B), "CT-8: mirror maths");
        assertEq(ageSlots, 0, "the mirror was just stamped");
        assertEq(blocksLeft, 6, "a one-slot window is six L2 blocks");
    }

    function test_ct8_mirror_age_is_in_whole_l1_slots() public {
        vm.warp(block.timestamp + 25);
        (, uint32 ageSlots,) = book.quote(1e18, Side.SELL_A_FOR_B);
        assertEq(ageSlots, 2, "25 s is two whole slots");
    }

    function test_ct8_blocks_remaining_counts_down_and_floors_at_zero() public {
        vm.roll(block.number + 4);
        assertEq(book.windowBlocksRemaining(), 2, "two blocks left");
        vm.roll(block.number + 10);
        assertEq(book.windowBlocksRemaining(), 0, "a stretched window does not go negative");
    }

    // ---------------------------------------------------------- EC-6 · window ----

    function test_ec6_window_slots_switch_at_the_boundary() public {
        assertEq(book.windowSlots(), 1);

        vm.prank(bookOwner);
        book.setWindowSlots(2);
        assertEq(book.windowSlots(), 1, "not mid-window");
        assertEq(book.pendingWindowSlots(), 2, "scheduled");

        bytes32 id = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        _settle(_ids(id));

        assertEq(book.windowSlots(), 2, "adopted at the boundary");
        assertEq(book.windowBlocksRemaining(), 12, "a two-slot window is twelve L2 blocks");
    }

    function test_ec6_window_slots_must_be_one_or_two() public {
        vm.prank(bookOwner);
        vm.expectRevert(WindowBook.InvalidConfiguration.selector);
        book.setWindowSlots(3);
    }

    function test_ec6_window_slots_are_owner_only() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.setWindowSlots(2);
    }

    // ------------------------------------------------------- CT-14 · latestPrice --

    function test_ct14_latest_price_is_empty_before_the_first_settlement() public view {
        (uint256 priceX96, uint64 l1Block,) = book.latestPrice();
        assertEq(priceX96, 0, "no settlement has returned a P0 yet");
        assertEq(l1Block, 0);
    }

    // --------------------------------------------------------------- §3 · settler --

    function test_settler_key_is_rotatable_by_the_owner() public {
        vm.prank(bookOwner);
        book.setSettler(carol);
        assertEq(book.settler(), carol);

        vm.prank(settler);
        vm.expectRevert(WindowBook.NotSettler.selector);
        book.settleWindow(new bytes32[](0), 0);
    }

    function test_settle_window_is_settler_only() public {
        vm.prank(alice);
        vm.expectRevert(WindowBook.NotSettler.selector);
        book.settleWindow(new bytes32[](0), 0);
    }

    function test_set_settler_is_owner_only() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.setSettler(alice);
    }

    // ------------------------------------------------------------------ helpers ---

    /// @dev An ETH-quoted pair: A is native zone ETH, B is the token.
    function _deployEthPair() private {
        BookConfig memory cfg = _defaultConfig();
        cfg.assetA = address(0);
        _deploy(cfg);
    }
}
