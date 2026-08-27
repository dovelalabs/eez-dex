// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IDexBridge} from "../../src/interfaces/IDexBridge.sol";
import {ISettlementRouter} from "../../src/interfaces/ISettlementRouter.sol";
import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {IWETH9} from "../../src/l1/interfaces/IWETH9.sol";
import {SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {MockERC20, MockERC20Decimals6, MockFeeOnTransferERC20} from "../mocks/MockERC20.sol";
import {MockPool} from "../mocks/MockPool.sol";
import {L1Fixture} from "./L1Fixture.sol";

/// @notice TS-1 for the L1 leg in the **genesis** form: zone ETH arrives as
/// `msg.value`, the residual is swapped against the real pool, and every
/// recipient is paid on L1 inside the same call (CT-1 … CT-4, CT-6).
///
/// Every test here runs twice — once with A as the pool's `token0`, once as
/// its `token1` — through the two concrete suites at the bottom of the file.
abstract contract SettlementRouterGenesisSuite is L1Fixture {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    function _bridge() internal pure override returns (IDexBridge) {
        return IDexBridge(address(0)); // genesis form: no bridge, L1 distribution
    }

    // --- CT-1 · onlyZone ---------------------------------------------------------

    function testFuzz_ct1_only_zone_may_settle(address caller) public {
        vm.assume(caller != ZONE_PROXY && caller != address(vm));
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, 0, 100, ""));

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(SettlementRouter.NotZone.selector, caller));
        router.settle(legs);
    }

    function test_ct1_zone_proxy_is_read_from_the_registry() public {
        assertEq(router.zoneProxy(), ZONE_PROXY, "gate follows the registry");
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, 0, 100, ""));

        // Rotate the registry's answer: the old proxy loses the gate, the new
        // one gains it, with no change to the router.
        address rotated = address(0xBEEF);
        eez.setProxy(WINDOW_BOOK, ZONE_ROLLUP_ID, rotated);

        vm.prank(ZONE_PROXY);
        vm.expectRevert(abi.encodeWithSelector(SettlementRouter.NotZone.selector, ZONE_PROXY));
        router.settle(legs);

        vm.prank(rotated);
        router.settle(legs);
    }

    // --- CT-1 · Expired ----------------------------------------------------------

    function test_ct1_expired_at_and_either_side_of_the_deadline() public {
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, 0, 100, ""));

        vm.warp(DEADLINE - 1);
        vm.prank(ZONE_PROXY);
        router.settle(legs);

        // `block.timestamp > deadline` — the deadline second itself is in time.
        vm.warp(DEADLINE);
        vm.prank(ZONE_PROXY);
        router.settle(legs);

        vm.warp(DEADLINE + 1);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(ISettlementRouter.Expired.selector);
        router.settle(legs);
    }

    // --- CT-1 · the price band, both bounds, both prices -------------------------

    function test_ct1_accepts_p0_at_both_band_boundaries() public {
        uint256 spot = _spotPriceX96();

        // P0 exactly on the floor, and exactly on the ceiling.
        _settleEmpty(spot, spot + 1);
        _settleEmpty(spot - 1, spot);
        _settleEmpty(spot, spot);
    }

    function test_ct1_reverts_when_p0_is_below_the_band() public {
        uint256 spot = _spotPriceX96();
        WindowLeg[] memory legs = _legs(_bandLeg(0, spot + 1, spot + 2, ""));

        vm.prank(ZONE_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementRouter.ReferencePriceOutsideBand.selector, spot, spot + 1, spot + 2)
        );
        router.settle(legs);
    }

    function test_ct1_reverts_when_p0_is_above_the_band() public {
        uint256 spot = _spotPriceX96();
        WindowLeg[] memory legs = _legs(_bandLeg(0, spot - 2, spot - 1, ""));

        vm.prank(ZONE_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementRouter.ReferencePriceOutsideBand.selector, spot, spot - 2, spot - 1)
        );
        router.settle(legs);
    }

    /// @notice The pool's 0.30% fee alone puts the realised average outside a
    /// 10 bp band, while `P0` — the pre-trade spot — sits at its centre. Only
    /// the second of CT-1's two checks can catch this.
    function test_ct1_reverts_when_realised_price_outside_band() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 10, _soleDistribution(ALICE, residualIn)));
        uint256 realised = _expectedExecutionPriceX96(Side.SELL_A_FOR_B, residualIn);
        assertLt(realised, legs[0].minPriceX96, "the fee alone breaks a 10 bp band");
        bytes memory expectedRevert = abi.encodeWithSelector(
            SettlementRouter.ExecutionPriceOutsideBand.selector, realised, legs[0].minPriceX96, legs[0].maxPriceX96
        );

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(expectedRevert);
        router.settle{value: residualIn}(legs);

        assertEq(MockERC20(tokenB).balanceOf(ALICE), 0, "nothing was delivered");
    }

    /// @notice The *other* bound of the same check. Selling B moves B per A up,
    /// so this residual's impact pushes the realised average past the band's
    /// ceiling while `P0` still sits at its centre — the only shape in which
    /// `executionPriceX96 > maxPriceX96` is reachable, and so the only test
    /// that pins CT-1's second check as genuinely two-sided.
    function test_ct1_reverts_when_realised_price_is_above_the_band() public {
        uint256 residualIn = 1 ether;
        uint256 realised = _expectedExecutionPriceX96(Side.SELL_B_FOR_A, residualIn);

        // A B-side residual is released into the router by the frame, not
        // carried as value; the genesis form never sells B, so this leg is here
        // for the band arithmetic alone.
        MockERC20(tokenB).mint(address(router), residualIn);
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_B_FOR_A, residualIn, 10, _soleDistribution(ALICE, residualIn)));
        assertGt(realised, legs[0].maxPriceX96, "the fee alone breaks a 10 bp band upward");
        assertLe(_spotPriceX96(), legs[0].maxPriceX96, "and P0 itself is inside, so only the second check can catch it");

        vm.prank(ZONE_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementRouter.ExecutionPriceOutsideBand.selector, realised, legs[0].minPriceX96, legs[0].maxPriceX96
            )
        );
        router.settle(legs);

        assertEq(MockERC20(tokenA).balanceOf(ALICE), 0, "nothing was delivered");
    }

    /// @notice Both bounds are inclusive for the realised price as well as for
    /// `P0`: a leg whose realised average lands exactly on the band's floor
    /// settles, because CT-1 asks for the price to lie *inside* the band.
    function test_ct1_accepts_a_realised_price_exactly_on_the_band_floor() public {
        uint256 residualIn = 1 ether;
        uint256 realised = _expectedExecutionPriceX96(Side.SELL_A_FOR_B, residualIn);
        uint256 spot = _spotPriceX96();

        // Floor exactly at the realised price, ceiling exactly at P0: both of
        // CT-1's checks sit on a bound and both must pass.
        WindowLeg[] memory legs = _legs(_bandLeg(residualIn, realised, spot, _soleDistribution(ALICE, residualIn)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        assertEq(results[0].referencePriceX96, spot, "P0 on the ceiling");
        assertEq(results[0].executionPriceX96, realised, "and the realised average on the floor");
    }

    /// @notice The failure-matrix row: the pool moves in the residual's favour
    /// past a *crossed* order's limit between selection and settlement. The
    /// upper bound of the band catches it on L1, so the frame is evicted free
    /// rather than filling the crossed order outside its limit.
    function test_ct1_reverts_when_a_favourable_move_breaks_a_crossed_limit() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 50, _soleDistribution(ALICE, residualIn)));

        // B per A doubles: the residual sells A, so this is its windfall and
        // the crossed buyers' broken limit.
        _moveSpot(2, 1);
        uint256 moved = _spotPriceX96();
        assertGt(moved, legs[0].maxPriceX96, "the move is past the band");

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementRouter.ReferencePriceOutsideBand.selector, moved, legs[0].minPriceX96, legs[0].maxPriceX96
            )
        );
        router.settle{value: residualIn}(legs);
    }

    // --- CT-2 · the result describes actual execution ----------------------------

    function test_ct2_result_describes_actual_execution() public {
        uint256 residualIn = 1 ether;
        uint256 spot = _spotPriceX96();
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        WindowResult memory r = results[0];
        assertEq(r.amountIn, residualIn, "amountIn is the residual");
        assertEq(r.amountOut, MockERC20(tokenB).balanceOf(ALICE), "amountOut is what was delivered");
        assertEq(r.referencePriceX96, spot, "P0 is the pre-trade spot, B per A");
        assertEq(r.executionPriceX96, Math.mulDiv(r.amountOut, Q96, r.amountIn), "realised average, B per A");
        assertLt(r.executionPriceX96, r.referencePriceX96, "the residual bears fee and impact");
        assertEq(r.l1Block, uint64(block.number), "the L1 block");

        // `post` is the pool's state after the swap — the next mirror (FL-1).
        (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();
        assertEq(r.post.sqrtPriceX96, sqrtPriceX96, "post sqrt price");
        assertEq(r.post.liquidity, pool.liquidity(), "post liquidity");
        assertEq(r.post.tick, tick, "post tick");
    }

    /// @dev Selling B moves B per A *up*, so this direction exercises the
    /// realised price against the band's ceiling and the reciprocal price path.
    function test_ct2_prices_are_b_per_a_on_both_sides() public {
        uint256 residualIn = 1 ether;
        uint256 spot = _spotPriceX96();

        // The full form's shape, reached here by funding the router directly:
        // a genesis leg always sells ETH, so B-side residuals are tested for
        // their price arithmetic only.
        MockERC20(tokenB).mint(address(router), residualIn);
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_B_FOR_A, residualIn, 100, _soleDistribution(ALICE, residualIn)));

        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        WindowResult memory r = results[0];
        assertEq(r.referencePriceX96, spot, "P0 is B per A regardless of side");
        assertEq(r.executionPriceX96, Math.mulDiv(r.amountIn, Q96, r.amountOut), "realised average, still B per A");
        assertGt(r.executionPriceX96, r.referencePriceX96, "selling B for A pays more B per A");
    }

    // --- CT-4 · genesis distribution ---------------------------------------------

    function test_ct4_pays_every_recipient_at_the_realised_average_price() public {
        address[] memory recipients = new address[](3);
        uint256[] memory sellAmounts = new uint256[](3);
        (recipients[0], recipients[1], recipients[2]) = (ALICE, BOB, CAROL);
        (sellAmounts[0], sellAmounts[1], sellAmounts[2]) = (0.5 ether, 0.25 ether, 0.25 ether);
        uint256 residualIn = 1 ether;

        WindowLeg[] memory legs =
            _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _distribution(recipients, sellAmounts)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        uint256 amountOut = results[0].amountOut;
        uint256 paid;
        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 expected = Math.mulDiv(sellAmounts[i], amountOut, residualIn);
            assertEq(MockERC20(tokenB).balanceOf(recipients[i]), expected, "share of the realised price");
            paid += expected;
        }
        assertLe(paid, amountOut, "no recipient is paid from another's share");
        assertEq(MockERC20(tokenB).balanceOf(address(router)), amountOut - paid, "dust stays with the protocol");
    }

    function testFuzz_ct4_outputs_round_down_and_dust_stays_with_the_protocol(uint96 a, uint96 b, uint96 c) public {
        // Above the wei scale where the venue's own rounding, not the leg's,
        // would dominate: the band still has to hold (CT-1).
        a = uint96(bound(a, 1e12, 1e21));
        b = uint96(bound(b, 1e12, 1e21));
        c = uint96(bound(c, 1e12, 1e21));
        uint256 residualIn = uint256(a) + b + c;

        address[] memory recipients = new address[](3);
        uint256[] memory sellAmounts = new uint256[](3);
        (recipients[0], recipients[1], recipients[2]) = (ALICE, BOB, CAROL);
        (sellAmounts[0], sellAmounts[1], sellAmounts[2]) = (a, b, c);

        WindowLeg[] memory legs =
            _legs(_leg(Side.SELL_A_FOR_B, residualIn, 500, _distribution(recipients, sellAmounts)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        uint256 amountOut = results[0].amountOut;
        uint256 paid;
        for (uint256 i = 0; i < recipients.length; ++i) {
            uint256 got = MockERC20(tokenB).balanceOf(recipients[i]);
            assertEq(got, Math.mulDiv(sellAmounts[i], amountOut, residualIn), "rounded down");
            paid += got;
        }
        assertLe(paid, amountOut, "sum of outputs never exceeds the leg's output");
        assertEq(MockERC20(tokenB).balanceOf(address(router)), amountOut - paid, "dust is retained, to the wei");
    }

    function test_ct4_reverts_when_the_distribution_does_not_sum_to_the_residual() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs =
            _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn - 1)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementRouter.DistributionMismatch.selector, residualIn - 1, residualIn)
        );
        router.settle{value: residualIn}(legs);
    }

    function test_ct4_reverts_when_a_residual_carries_no_distribution() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, ""));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(SettlementRouter.MissingDistribution.selector);
        router.settle{value: residualIn}(legs);
    }

    function test_ct4_reverts_when_value_does_not_match_the_sell_side() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn)));

        vm.deal(ZONE_PROXY, residualIn + 1);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(abi.encodeWithSelector(SettlementRouter.ValueMismatch.selector, residualIn + 1, residualIn));
        router.settle{value: residualIn + 1}(legs);
    }

    // --- CT-6 · the empty settlement ---------------------------------------------

    function test_ct6_empty_settlement_refreshes_the_mirror_without_swapping() public {
        uint160 before = pool.sqrtPriceX96();
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, 0, 100, ""));

        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        WindowResult memory r = results[0];
        assertEq(r.amountIn, 0, "nothing in");
        assertEq(r.amountOut, 0, "nothing out");
        assertEq(r.referencePriceX96, _spotPriceX96(), "the current spot");
        assertEq(r.executionPriceX96, r.referencePriceX96, "no swap, no impact");
        assertEq(r.post.sqrtPriceX96, before, "the pool was not traded");
        assertEq(pool.sqrtPriceX96(), before, "the pool was not traded");
        assertEq(r.l1Block, uint64(block.number), "the L1 block");
    }

    // --- CT-1 · a batch of legs (EC-5) -------------------------------------------

    function test_ct1_settles_a_batch_of_legs() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = new WindowLeg[](2);
        legs[0] = _leg(Side.SELL_A_FOR_B, 0, 100, "");
        legs[1] = _leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        assertEq(results.length, 2, "one result per leg, in order");
        assertEq(results[0].amountIn, 0, "the refresh leg swapped nothing");
        assertEq(results[1].amountIn, residualIn, "the residual leg swapped");
        assertEq(MockERC20(tokenB).balanceOf(ALICE), results[1].amountOut, "the sole recipient takes it whole");
    }

    // --- TS-1 · awkward tokens ----------------------------------------------------

    function test_ts1_rejects_a_fee_on_transfer_buy_token() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20("Fee", "FEE", 18, 100);
        (SettlementRouter altRouter,) = _altVenue(MockERC20(address(fot)));

        uint256 residualIn = 1 ether;
        WindowLeg memory leg = WindowLeg({
            windowId: 1,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: residualIn,
            minPriceX96: 0,
            maxPriceX96: type(uint256).max,
            deadline: DEADLINE,
            distribution: _soleDistribution(ALICE, residualIn)
        });

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(abi.encodeWithSelector(SettlementRouter.UnsupportedToken.selector, address(fot)));
        altRouter.settle{value: residualIn}(_legs(leg));
    }

    function test_ts1_settles_a_six_decimal_buy_token() public {
        MockERC20Decimals6 usdc = new MockERC20Decimals6("Six", "SIX");
        (SettlementRouter altRouter,) = _altVenue(MockERC20(address(usdc)));

        uint256 residualIn = 1 ether;
        WindowLeg memory leg = WindowLeg({
            windowId: 1,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: residualIn,
            minPriceX96: 0,
            maxPriceX96: type(uint256).max,
            deadline: DEADLINE,
            distribution: _soleDistribution(ALICE, residualIn)
        });

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = altRouter.settle{value: residualIn}(_legs(leg));

        assertGt(results[0].amountOut, 0, "a six-decimal output settles");
        assertEq(usdc.balanceOf(ALICE), results[0].amountOut, "one recipient takes it whole");
        assertEq(usdc.decimals(), 6, "and it really is six decimals");
    }

    // --- helpers ------------------------------------------------------------------

    function _settleEmpty(uint256 minPriceX96, uint256 maxPriceX96) internal {
        vm.prank(ZONE_PROXY);
        router.settle(_legs(_bandLeg(0, minPriceX96, maxPriceX96, "")));
    }

    function _bandLeg(
        uint256 residualIn,
        uint256 minPriceX96,
        uint256 maxPriceX96,
        bytes memory distribution
    )
        internal
        pure
        returns (WindowLeg memory)
    {
        return WindowLeg({
            windowId: 1,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: residualIn,
            minPriceX96: minPriceX96,
            maxPriceX96: maxPriceX96,
            deadline: DEADLINE,
            distribution: distribution
        });
    }

    /// @dev What the swap would realise, computed by simulating it and rolling
    /// the state back — so the expectation is the pool's arithmetic, not a
    /// restatement of the router's.
    function _expectedExecutionPriceX96(Side side, uint256 residualIn) internal returns (uint256 priceX96) {
        uint256 snapshot = vm.snapshotState();
        MockERC20 sellToken = MockERC20(side == Side.SELL_A_FOR_B ? tokenA : tokenB);
        MockERC20 buyToken = MockERC20(side == Side.SELL_A_FOR_B ? tokenB : tokenA);

        sellToken.mint(address(adapter), residualIn);
        uint256 amountOut = adapter.swap(side, residualIn, 0);
        assertEq(buyToken.balanceOf(address(this)), amountOut, "the adapter pays its caller");

        priceX96 = side == Side.SELL_A_FOR_B
            ? Math.mulDiv(amountOut, Q96, residualIn)
            : Math.mulDiv(residualIn, Q96, amountOut);
        vm.revertToState(snapshot);
    }

    /// @dev Moves the pool so B per A becomes `num/den` of what it is now.
    function _moveSpot(uint256 num, uint256 den) internal {
        (uint256 sqrtNum, uint256 sqrtDen) = _aIsToken0() ? (num, den) : (den, num);
        uint256 sqrtPriceX96 = uint256(pool.sqrtPriceX96());
        pool.setSqrtPriceX96(uint160(Math.mulDiv(sqrtPriceX96, Math.sqrt(sqrtNum * 1e18 / sqrtDen), 1e9)));
    }

    /// @dev A second pool of the same shape with a different B asset, for the
    /// token-behaviour rows of TS-1.
    function _altVenue(MockERC20 altB) internal returns (SettlementRouter altRouter, MockPool altPool) {
        altPool = _deployPool(address(weth), address(altB), POOL_SQRT_PRICE, POOL_LIQUIDITY);
        UniswapV3Adapter altAdapter = new UniswapV3Adapter(address(altPool), address(weth));
        altRouter = new SettlementRouter(
            eez,
            ZONE_ROLLUP_ID,
            WINDOW_BOOK,
            altAdapter,
            address(weth),
            address(altB),
            IWETH9(address(weth)),
            IDexBridge(address(0))
        );
    }
}

/// @notice The pair's A asset is the pool's `token0`.
contract SettlementRouterGenesisTest is SettlementRouterGenesisSuite {
    function _aIsToken0() internal pure override returns (bool) {
        return true;
    }
}

/// @notice The pair's A asset is the pool's `token1` — every price is the
/// reciprocal, and B per A must still come out right (A.1, CT-2).
contract SettlementRouterGenesisInvertedTest is SettlementRouterGenesisSuite {
    function _aIsToken0() internal pure override returns (bool) {
        return false;
    }
}
