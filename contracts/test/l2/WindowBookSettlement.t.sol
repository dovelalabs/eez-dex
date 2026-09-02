// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Credit} from "../../src/interfaces/IDexBridge.sol";
import {IWindowBook} from "../../src/interfaces/IWindowBook.sol";
import {Mirror} from "../../src/l2/Mirror.sol";
import {BookConfig, FeeMode, OrderStatus, Profile, RouteFeeModel, WindowBook} from "../../src/l2/WindowBook.sol";
import {PoolState, Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {MockZoneProxy} from "./mocks/MockZone.sol";
import {WindowBookFixture} from "./WindowBookFixture.sol";

/// @notice TS-1 — the settlement half of WP-2: CT-9 (the contract builds the leg),
/// CT-10 (the last check), CT-11 (delivery), CT-12 (fees, rounding, dust), CT-13
/// (escrow), CT-14 (`latestPrice`), and FL-4/FL-5/FL-7/FL-8.
contract WindowBookSettlementTest is WindowBookFixture {
    /// @dev The window this suite keeps returning to: 10 A offered, 10,000 B bid, at a
    /// mirror of 2000 B per A. The B side is the smaller one, so it crosses whole and
    /// the A side carries the residual.
    uint256 private constant SELL_A = 10e18;
    uint256 private constant SELL_B = 10_000e18;

    /// @dev The leg-parity fixture (TS-1): 10 A at a 19,000 B limit crossed against
    /// 10,000 B at a 4.9 A limit, 1 bp fee, mirror at 2000 B per A. WP-3's window
    /// builder must produce these exact numbers for the same inputs; they are mirrored
    /// in `test/l2/fixtures/leg-parity.json`.
    uint256 private constant LEG_PARITY_RESIDUAL_IN = 4_999_500_000_000_000_000;
    uint256 private constant LEG_PARITY_MIN_PRICE_X96 = 150_548_563_633_465_587_986_532_158_854_286;
    uint256 private constant LEG_PARITY_MAX_PRICE_X96 = 161_673_958_567_373_288_081_193_052_940_747;

    // ------------------------------------------- CT-9 · the contract builds the leg ---

    function test_ct9_the_contract_builds_the_leg_from_order_ids_alone() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);

        _settle(_ids(a, b));

        WindowLeg memory leg = proxy.leg();

        uint256 netA = SELL_A - _feeBps(SELL_A);
        uint256 netB = SELL_B - _feeBps(SELL_B);
        uint256 crossed = Math.mulDiv(netB, Q96, _mirrorPrice());

        assertEq(leg.windowId, 0, "the window being settled");
        assertEq(uint8(leg.residualSide), uint8(Side.SELL_A_FOR_B), "FL-4: the A side is the larger one");
        assertEq(leg.residualIn, netA - crossed, "FL-4: residual is the net after crossing");
        assertEq(leg.minPriceX96, 0, "no sell-side limit binds");
        assertEq(leg.maxPriceX96, type(uint256).max, "no buy-side limit binds");
        assertEq(proxy.callCount(), 1, "exactly one cross-layer call");
    }

    /// @dev FL-4 as a property: whichever way the window leans, the residual is the net
    /// of the two sides valued at the clearing price, and the crossed volume is the
    /// smaller side entire.
    function testFuzz_fl4_residual_is_the_net_at_the_clearing_price(uint96 sellA, uint96 sellB) public {
        sellA = uint96(bound(sellA, 1e15, 50e18));
        sellB = uint96(bound(sellB, 1e15, 100_000e18));

        bytes32 a = _place(alice, Side.SELL_A_FOR_B, sellA, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, sellB, 0);
        _settle(_ids(a, b));

        uint256 netA = sellA - _feeBps(sellA);
        uint256 netB = sellB - _feeBps(sellB);
        uint256 priceX96 = _mirrorPrice();
        uint256 netBinA = Math.mulDiv(netB, Q96, priceX96);

        WindowLeg memory leg = proxy.leg();
        if (netA >= netBinA) {
            assertEq(uint8(leg.residualSide), uint8(Side.SELL_A_FOR_B), "A is the larger side");
            assertEq(leg.residualIn, netA - netBinA, "residual is the net");
        } else {
            assertEq(uint8(leg.residualSide), uint8(Side.SELL_B_FOR_A), "B is the larger side");
            assertEq(leg.residualIn, netB - Math.mulDiv(netA, priceX96, Q96), "residual is the net");
        }
        _assertEscrowInvariant();
    }

    /// @dev A window with only one side has nothing to cross: the whole of it is the
    /// residual. **[genesis]** this is every window (FL-4).
    function test_fl4_a_one_sided_window_is_all_residual() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(a));

        assertEq(proxy.leg().residualIn, SELL_A - _feeBps(SELL_A), "nothing crossed");
    }

    /// @dev CT-9's band: the tightest limit on each side, each already widened by that
    /// side's fee because both bounds are derived from `netIn`.
    function test_ct9_price_band_is_the_tightest_limit_on_each_side() public {
        uint256 minBuyA = 19_000e18;
        uint256 minBuyB = 4.9e18;
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, minBuyA);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, minBuyB);
        // A looser A-side limit must not move the lower bound.
        bytes32 c = _place(carol, Side.SELL_A_FOR_B, SELL_A, 18_000e18);

        _settle(_ids(a, b, c));

        WindowLeg memory leg = proxy.leg();
        uint256 netA = SELL_A - _feeBps(SELL_A);
        uint256 netB = SELL_B - _feeBps(SELL_B);
        assertEq(leg.minPriceX96, Math.mulDiv(minBuyA, Q96, netA, Math.Rounding.Ceil), "tightest sell-side limit");
        assertEq(leg.maxPriceX96, Math.mulDiv(netB, Q96, minBuyB), "tightest buy-side limit");
    }

    function test_ct9_an_order_without_a_limit_does_not_bind_the_band() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(a));
        assertEq(proxy.leg().minPriceX96, 0);
        assertEq(proxy.leg().maxPriceX96, type(uint256).max);
    }

    // ------------------------------------------------ FL-7 · free, foreseen failures ---

    function test_fl7_nothing_to_settle_reverts_before_any_l1_call() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        vm.prank(alice);
        book.cancel(a);

        vm.prank(settler);
        vm.expectRevert(WindowBook.NothingToSettle.selector);
        book.settleWindow(_ids(a), uint64(block.timestamp + 24));

        assertEq(proxy.callCount(), 0, "FL-7: foreseeable reverts happen before the L1 call");
    }

    function test_fl7_an_empty_price_band_reverts_before_any_l1_call() public {
        // A wants at least 2100 B per A; B will not pay more than 1900.
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 21_000e18);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 5.264e18);

        vm.prank(settler);
        vm.expectRevert();
        book.settleWindow(_ids(a, b), uint64(block.timestamp + 24));

        assertEq(proxy.callCount(), 0, "FL-7: an empty band is foreseeable on L2");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "orders stay open");
        assertEq(book.escrowed(address(tokenA)), SELL_A, "escrow untouched");
        _assertEscrowInvariant();
    }

    /// @dev Regression (CT-13): a selection whose whole volume is worth less than one
    /// unit of the other asset nets to nothing — no cross, no residual. Settling it once
    /// closed every order at a zero fill and left the input inside the contract but
    /// outside the ledger. It is foreseeable on L2, so it reverts before the L1 call.
    function test_ct13_a_selection_too_small_to_net_reverts_before_any_l1_call() public {
        // **[genesis]** with zone ETH as B: 1000 wei is worth less than one unit of A at
        // 2000 B per A, so the netting rounds the whole window away.
        BookConfig memory cfg = _defaultConfig();
        cfg.profile = Profile.GENESIS;
        cfg.assetB = address(0);
        cfg.bridgeL2 = address(0);
        _deploy(cfg);

        bytes32 a = _placeEth(alice, Side.SELL_B_FOR_A, 1000, 0);

        vm.prank(settler);
        vm.expectRevert(WindowBook.NothingToSettle.selector);
        book.settleWindow(_ids(a), uint64(block.timestamp + 24));

        assertEq(proxy.callCount(), 0, "FL-7: nothing to net is foreseeable on L2");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "the order stays open");
        assertEq(book.escrowed(address(0)), 1000, "escrow intact");
        assertEq(book.escrowInvariantDrift(address(0)), 0, "CT-13: nothing left the ledger");
    }

    /// @dev A revert anywhere in the frame reverts the whole transaction, which is
    /// poison-evicted at compose time: no fills, no escrow moved, the window still open.
    function test_fl7_a_reverting_l1_leg_leaves_the_window_untouched() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        proxy.setRevertNextCall(true);

        vm.prank(settler);
        vm.expectRevert(bytes("l1 leg reverted"));
        book.settleWindow(_ids(a, b), uint64(block.timestamp + 24));

        assertEq(book.windowId(), 0, "the window did not advance");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN));
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.OPEN));
        assertEq(book.escrowed(address(tokenA)), SELL_A, "escrow intact");
        assertEq(book.escrowed(address(tokenB)), SELL_B, "escrow intact");
        _assertEscrowInvariant();
    }

    // ------------------------------------------------ FL-5 · reference price and impact ---

    /// @dev With the mirror and the L1 head agreeing, `P0` *is* the price the window
    /// netted at, so a crossed order fills at exactly the reference price and pays no
    /// impact — the FL-5 case CT-9 names.
    function test_fl5_a_crossed_order_fills_at_the_reference_price_and_pays_no_impact() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);

        uint256 netB = SELL_B - _feeBps(SELL_B);
        uint256 expected = Math.mulDiv(netB, Q96, _mirrorPrice());

        vm.expectEmit(true, false, false, true, address(book));
        emit IWindowBook.OrderFilled(b, expected, _feeBps(SELL_B), 0, 0);
        _settle(_ids(a, b));

        assertEq(book.balanceOf(address(tokenA), bob), expected, "crossed fill at P0");
        (uint256 p0,,) = book.latestPrice();
        assertEq(p0, _mirrorPrice(), "P0 is the reference price the leg returned");
    }

    /// @dev The residual side caused the swap, so it carries the difference between the
    /// reference price and what the pool actually gave — and nothing else does (FL-5,
    /// EC-3): the crossed side's outcome above is independent of it.
    function test_fl5_the_residual_side_pays_the_impact() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        _settle(_ids(a, b));

        uint256 netA = SELL_A - _feeBps(SELL_A);
        uint256 filled = book.balanceOf(address(tokenB), alice);
        uint256 atReferencePrice = Mirror.valueIn(netA, _mirrorPrice(), Side.SELL_A_FOR_B);

        assertLt(filled, atReferencePrice, "the residual side pays impact");
        assertGt(filled, (atReferencePrice * 99) / 100, "and only impact: tens of bps on this residual");
    }

    /// @dev EC-3 stated as a test: what the crossed side receives does not depend on how
    /// far the residual moved the pool, so watching L2 order flow and taking the
    /// opposite side captures nothing.
    function test_ec3_the_crossed_side_receives_no_windfall_from_a_larger_residual() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        _settle(_ids(a, b));
        uint256 small = book.balanceOf(address(tokenA), bob);

        setUp();

        bytes32 a2 = _place(alice, Side.SELL_A_FOR_B, SELL_A * 20, 0);
        bytes32 b2 = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        _settle(_ids(a2, b2));
        uint256 large = book.balanceOf(address(tokenA), bob);

        assertEq(small, large, "EC-3: the crossed side is indifferent to the residual's impact");
    }

    // ------------------------------------------------------- CT-10 · the last check ---

    /// @dev The guard against a settler — and a router — that hand back a result the
    /// price band would never have allowed. The order's net output is below its limit,
    /// so the whole transaction reverts and is poison-evicted for free.
    function test_ct10_rejects_fill_below_min_buy() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 19_000e18);
        _forceResult(_result({amountOut: 18_000e18, priceX96: _mirrorPrice()}), true);

        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(WindowBook.LimitViolated.selector, a, uint256(18_000e18), uint256(19_000e18))
        );
        book.settleWindow(_ids(a), uint64(block.timestamp + 24));

        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "the order rolls, it is not filled badly");
        _assertEscrowInvariant();
    }

    /// @dev "…nor at a better one." A result claiming more output than the frame
    /// actually delivered cannot be paid out of thin air (CT-10, CT-11).
    function test_ct10_cannot_fill_better_than_the_leg_delivered() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _forceResult(_result({amountOut: 1_000_000e18, priceX96: _mirrorPrice()}), false);

        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(WindowBook.DeliveryShortfall.selector, uint256(1_000_000e18), uint256(0))
        );
        book.settleWindow(_ids(a), uint64(block.timestamp + 24));
    }

    /// @dev The failure-matrix row: the pool moves in the residual's *favour*, past a
    /// crossed order's limit. The L1 leg's band rejects `P0` and the whole frame is
    /// evicted — nobody is filled outside their limit and no L1 gas is spent.
    function test_ct10_a_favourable_move_that_breaks_a_crossed_limit_reverts() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        // Bob will not pay more than ~2020 B per A.
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 4.95e18);

        // The A side's residual is a sell, so a *rise* is the move in its favour.
        _driftL1(2100 * Q96);

        vm.prank(settler);
        vm.expectRevert();
        book.settleWindow(_ids(a, b), uint64(block.timestamp + 24));

        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "no fill outside a limit");
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.OPEN));
        assertEq(book.windowId(), 0, "the window stays open");
        _assertEscrowInvariant();
    }

    /// @dev FL-8: drift is handled by selection, not by bad fills. The settler leaves
    /// the order it can no longer fill out of the selection; it stays open for the next
    /// window and the rest settle.
    function test_fl8_an_order_outside_its_limit_is_left_out_and_stays_open() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 tight = _place(carol, Side.SELL_A_FOR_B, SELL_A, 21_000e18);

        _settle(_ids(a)); // the settler selects only what it can fill

        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(tight)), uint8(OrderStatus.OPEN), "FL-8: rolled, not filled badly");
        assertEq(book.escrowed(address(tokenA)), SELL_A, "its escrow is still escrowed");
        _assertEscrowInvariant();
    }

    // ------------------------------------------------------- CT-7 · the cancel race ---

    /// @dev A cancel ordered before `settleWindow` in the Sync block simply shrinks the
    /// selection. It can never revert a settlement, which is what CT-7 and CT-9 exist to
    /// guarantee: the settler's list is a suggestion, not an instruction.
    function test_ct7_cancel_in_sync_block_shrinks_selection() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        bytes32 c = _place(carol, Side.SELL_A_FOR_B, SELL_A, 0);

        // Carol's cancel lands in the Sync block, ahead of the settlement.
        vm.prank(carol);
        book.cancel(c);

        _settle(_ids(a, b, c)); // the settler still names all three

        assertEq(book.windowId(), 1, "N-1 fills, no revert, no eviction");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(c)), uint8(OrderStatus.CANCELLED));
        assertEq(book.balanceOf(address(tokenB), carol), 0, "the cancelled order was not filled");
        _assertEscrowInvariant();
    }

    function test_ct9_an_expired_id_in_the_selection_is_dropped_not_filled() public {
        bytes32 stale = _placeExpiring(alice, Side.SELL_A_FOR_B, SELL_A, 0, 0);
        bytes32 fresh = _place(bob, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(fresh)); // advances the window past `stale`'s expiry

        bytes32 next = _place(carol, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(stale, next));

        assertEq(uint8(book.statusOf(next)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(stale)), uint8(OrderStatus.EXPIRED), "swept, never filled");
        _assertEscrowInvariant();
    }

    /// @dev A duplicated id must not fill the same order twice (CT-9).
    function test_ct9_a_repeated_id_is_counted_once() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(a, a));

        assertEq(proxy.leg().residualIn, SELL_A - _feeBps(SELL_A), "counted once");
        _assertEscrowInvariant();
    }

    // --------------------------------------------------------------- FL-8 · rolling ---

    function test_fl8_unselected_orders_remain_open() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 unselected = _place(carol, Side.SELL_A_FOR_B, SELL_A, 0);

        _settle(_ids(a));

        assertEq(uint8(book.statusOf(unselected)), uint8(OrderStatus.OPEN), "still open for the next window");
        assertEq(book.openOrderCount(), 1);
    }

    /// @dev An order placed in the Sync block after `settleWindow` belongs to the next
    /// window (CT-7).
    function test_ct7_an_order_placed_after_settlement_belongs_to_the_next_window() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(a));

        bytes32 late = _place(bob, Side.SELL_A_FOR_B, SELL_A, 0);
        assertEq(book.placedWindow(late), 1, "the next window");
    }

    // ------------------------------------------------------------ CT-11 · delivery ---

    /// @dev **[full]** the bought asset arrives inside the frame and is booked to the
    /// recipient's L2 balance in the same transaction.
    function test_ct11_full_delivery_credits_l2_balances_in_frame() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);

        _settle(_ids(a, b));

        assertGt(book.balanceOf(address(tokenB), alice), 0, "A side holds B");
        assertGt(book.balanceOf(address(tokenA), bob), 0, "B side holds A");
        _assertEscrowInvariant();
        _assertHoldingsCover(address(tokenA));
        _assertHoldingsCover(address(tokenB));
    }

    /// @dev **[full]** CT-5's sell side: the burn on L2 releases the L1 reserve **to
    /// the router**, which is where the swap that follows it in the same frame takes
    /// its input from. Regression (Phase 6): releasing to the burner sent the reserve
    /// to this contract's address on L1, where nothing is deployed, and the router
    /// reverted with the reserve stranded — a defect no unit suite could see, because
    /// where the reserve lands is an L1 fact.
    function test_ct5_the_sell_side_reserve_is_released_to_the_router() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);

        _settle(_ids(a));

        assertEq(bridgeL2.lastReleaseRecipient(), ROUTER_L1, "CT-5: the reserve is released to the router");
    }

    /// @dev **[genesis]** every order sells zone ETH, there is no crossing, the sell
    /// side leaves as the call's `value`, and delivery is the L1 distribution the leg
    /// carries (CT-4, CT-11).
    function test_ct11_genesis_sends_value_and_carries_the_l1_distribution() public {
        _deployGenesis();

        bytes32 a = _placeEth(alice, Side.SELL_A_FOR_B, 1e18, 0);
        bytes32 b = _placeEth(bob, Side.SELL_A_FOR_B, 3e18, 0);
        _settle(_ids(a, b));

        uint256 netA = 1e18 - _feeBps(1e18);
        uint256 netB = 3e18 - _feeBps(3e18);

        WindowLeg memory leg = proxy.leg();
        assertEq(leg.residualIn, netA + netB, "FL-4 is vacuous: the whole window is the residual");
        assertEq(proxy.lastValue(), leg.residualIn, "the sell side rides as call value");

        Credit[] memory credits = abi.decode(leg.distribution, (Credit[]));
        assertEq(credits.length, 2, "one entry per residual-side order");
        assertEq(credits[0].recipient, alice);
        assertEq(credits[0].amount, netA, "net of the fee withheld on L2, so the sum is the residual");
        assertEq(credits[1].recipient, bob);
        assertEq(credits[1].amount, netB);

        assertEq(book.balanceOf(address(tokenB), alice), 0, "nothing is delivered on L2");
        assertEq(book.escrowInvariantDrift(address(0)), 0, "CT-13 holds for the ETH leg");
        assertEq(book.escrowInvariantDrift(address(tokenB)), 0, "and nothing is booked in an asset never received");
    }

    function test_genesis_rejects_an_order_that_does_not_sell_zone_eth() public {
        _deployGenesis();
        _fund(bob, tokenB, 1e18);
        vm.prank(bob);
        vm.expectRevert(WindowBook.UnsupportedSellAsset.selector);
        book.place(_order(bob, Side.SELL_B_FOR_A, 1e18, 0));
    }

    // ---------------------------------------------------------------- CT-12 · fees ---

    function test_ct12_fee_bps_is_taken_in_the_sell_asset() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);

        vm.expectEmit(true, false, false, false, address(book));
        emit IWindowBook.OrderFilled(a, 0, 0, 0, 0);
        _settle(_ids(a));

        assertEq(book.feesAccrued(address(tokenA)), _feeBps(SELL_A), "1 bp of notional, in A");
        assertEq(book.feesAccrued(address(tokenB)), 0, "never in the buy asset");
        _assertEscrowInvariant();
    }

    function test_ct12_fee_fixed_is_a_flat_amount_per_order() public {
        BookConfig memory cfg = _defaultConfig();
        cfg.feeMode = FeeMode.FIXED;
        cfg.feeFixedA = 0.002e18;
        cfg.feeFixedB = 4e18;
        _deploy(cfg);

        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 0);
        _settle(_ids(a, b));

        assertEq(book.feesAccrued(address(tokenA)), 0.002e18, "flat, whatever the size");
        assertEq(book.feesAccrued(address(tokenB)), 4e18);

        uint256 netA = SELL_A - 0.002e18;
        uint256 netB = SELL_B - 4e18;
        assertEq(proxy.leg().residualIn, netA - Math.mulDiv(netB, Q96, _mirrorPrice()), "netting is net of the fee");
        _assertEscrowInvariant();
    }

    /// @dev EC-1's high-gas fallback: the window's route fee split pro-rata by fill
    /// size, taken in the sell asset, converted from wei for the leg that is not ETH.
    function test_ct12_route_fee_recover_splits_pro_rata_by_fill_size() public {
        BookConfig memory cfg = _defaultConfig();
        cfg.assetB = address(0); // an ETH-quoted pair, so wei has a meaning on one leg
        cfg.routeFeeModel = RouteFeeModel.RECOVER;
        cfg.routeFeeWei = 0.003e18;
        cfg.feeBps = 0;
        _deploy(cfg);

        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        bytes32 b = _placeEth(bob, Side.SELL_B_FOR_A, 1000e18, 0);

        vm.recordLogs();
        _settle(_ids(a, b));

        // A's notional is 1 A; B's is 1000 ETH / 2000 = 0.5 A. A pays two thirds.
        uint256 priceX96 = _mirrorPrice();
        uint256 notionalB = Math.mulDiv(1000e18, Q96, priceX96);
        uint256 total = 1e18 + notionalB;
        uint256 shareAWei = Math.mulDiv(0.003e18, 1e18, total);
        uint256 shareBWei = Math.mulDiv(0.003e18, notionalB, total);

        // A sells the token, so its share converts from wei at the mirror price; B sells
        // ETH, so its share is already in the sell asset.
        assertEq(book.feesAccrued(address(tokenA)), Math.mulDiv(shareAWei, Q96, priceX96), "A's share, converted");
        assertEq(book.feesAccrued(address(0)), shareBWei, "B's share, in wei");
        _assertEscrowInvariant();
    }

    function test_ct12_absorbed_route_fee_costs_a_fill_nothing() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);

        vm.recordLogs();
        _settle(_ids(a));

        assertEq(book.feesAccrued(address(tokenA)), _feeBps(SELL_A), "the protocol fee, and nothing more");
    }

    // ------------------------------------------------------ CT-12 · rounding, dust ---

    /// @dev Per-order outputs round down; the sum never exceeds the leg's output plus
    /// the crossed volume; the remainder is dust and dust accrues to the protocol fee
    /// bucket. The invariant is what makes that safe: dust is inside CT-13, not outside
    /// it.
    function testFuzz_ct12_outputs_round_down_and_dust_is_booked(uint96 sellA1, uint96 sellA2, uint96 sellB1) public {
        sellA1 = uint96(bound(sellA1, 1e12, 20e18));
        sellA2 = uint96(bound(sellA2, 1e12, 20e18));
        sellB1 = uint96(bound(sellB1, 1e12, 40_000e18));

        bytes32 a1 = _place(alice, Side.SELL_A_FOR_B, sellA1, 0);
        bytes32 a2 = _place(carol, Side.SELL_A_FOR_B, sellA2, 0);
        bytes32 b1 = _place(bob, Side.SELL_B_FOR_A, sellB1, 0);

        _settle(_ids(a1, a2, b1));

        WindowLeg memory leg = proxy.leg();
        uint256 netB = sellB1 - _feeBps(sellB1);
        uint256 netA = (sellA1 - _feeBps(sellA1)) + (sellA2 - _feeBps(sellA2));

        // Sigma of outputs in each asset can never exceed what the window had to pay
        // them with.
        uint256 paidInB = book.balanceOf(address(tokenB), alice) + book.balanceOf(address(tokenB), carol);
        uint256 paidInA = book.balanceOf(address(tokenA), bob);

        if (leg.residualSide == Side.SELL_A_FOR_B) {
            uint256 legOut = Mirror.quote(_poolState(PRICE_X96), leg.residualIn, Side.SELL_A_FOR_B);
            assertLe(paidInB, netB + legOut, "CT-12: outputs never exceed the leg's output plus crossed volume");
            assertLe(paidInA, netA, "the crossed side is paid out of the residual side's escrow");
        } else {
            uint256 legOut = Mirror.quote(_poolState(PRICE_X96), leg.residualIn, Side.SELL_B_FOR_A);
            assertLe(paidInA, netA + legOut, "CT-12: outputs never exceed the leg's output plus crossed volume");
            assertLe(paidInB, netB, "the crossed side is paid out of the residual side's escrow");
        }

        _assertEscrowInvariant();
        _assertHoldingsCover(address(tokenA));
        _assertHoldingsCover(address(tokenB));
    }

    // ------------------------------------------------------- CT-14 · latestPrice ----

    function test_ct14_latest_price_equals_the_settlement_reference_and_ages() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        proxy.setL1Block(21_000_000);
        _settle(_ids(a));

        (uint256 priceX96, uint64 l1Block, uint32 ageSlots) = book.latestPrice();
        assertEq(priceX96, _mirrorPrice(), "CT-14: the last settlement's P0");
        assertEq(l1Block, 21_000_000, "the L1 block it was read in");
        assertEq(ageSlots, 0, "just stamped");

        vm.warp(block.timestamp + 36);
        (,, ageSlots) = book.latestPrice();
        assertEq(ageSlots, 3, "three slots later");
    }

    /// @dev FL-1: the mirror is refreshed from the leg's return, so it is never more
    /// than one settlement stale.
    function test_fl1_the_mirror_adopts_the_post_trade_state() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        _settle(_ids(a));

        (uint160 sqrtPriceX96,,) = book.mirror();
        (uint160 poolSqrtPriceX96,,) = proxy.poolState();
        assertEq(sqrtPriceX96, poolSqrtPriceX96, "the mirror is the pool's post-trade state");
        assertEq(book.mirrorTimestamp(), uint64(block.timestamp), "and it is stamped now");
    }

    // ------------------------------------------------------- TS-1 · leg parity -------

    /// @dev The settler builds the same leg for the same inputs (SV-2), so this is WP-2's
    /// half of that fixture: known orders in, one exact `WindowLeg` out. The same numbers
    /// live in `test/l2/fixtures/leg-parity.json`, which WP-3 asserts against.
    function test_ts1_leg_parity_fixture() public {
        BookConfig memory cfg = _defaultConfig();
        cfg.feeBps = 1;
        _deploy(cfg);

        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 10e18, 19_000e18);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, 10_000e18, 4.9e18);

        vm.prank(settler);
        book.settleWindow(_ids(a, b), 1_800_000_024);

        WindowLeg memory leg = proxy.leg();

        assertEq(leg.windowId, 0, "leg-parity: windowId");
        assertEq(uint8(leg.residualSide), uint8(Side.SELL_A_FOR_B), "leg-parity: residualSide");
        assertEq(leg.residualIn, LEG_PARITY_RESIDUAL_IN, "leg-parity: residualIn");
        assertEq(leg.minPriceX96, LEG_PARITY_MIN_PRICE_X96, "leg-parity: minPriceX96");
        assertEq(leg.maxPriceX96, LEG_PARITY_MAX_PRICE_X96, "leg-parity: maxPriceX96");
        assertEq(leg.deadline, 1_800_000_024, "leg-parity: deadline");
        assertEq(leg.distribution.length, 0, "leg-parity: [full] carries no L1 distribution");
    }

    // ------------------------------------------------------------------ helpers ---

    function _feeBps(uint256 amount) private pure returns (uint256) {
        return Math.mulDiv(amount, 1, 10_000);
    }

    function _mirrorPrice() private view returns (uint256) {
        return Mirror.spotPriceX96(_poolState(PRICE_X96));
    }

    function _result(uint256 amountOut, uint256 priceX96) private view returns (WindowResult memory result) {
        result = WindowResult({
            amountIn: 0,
            amountOut: amountOut,
            referencePriceX96: priceX96,
            executionPriceX96: priceX96,
            post: _poolState(PRICE_X96),
            l1Block: 1
        });
    }

    function _forceResult(WindowResult memory result, bool delivers) private {
        proxy.setForcedResult(result, delivers);
    }

    /// @dev **[genesis]** A is zone ETH; every order sells it.
    function _deployGenesis() private {
        BookConfig memory cfg = _defaultConfig();
        cfg.profile = Profile.GENESIS;
        cfg.assetA = address(0);
        cfg.bridgeL2 = address(0);
        _deploy(cfg);
    }
}
