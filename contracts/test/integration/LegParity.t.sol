// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Vm} from "forge-std/Test.sol";

import {ISettlementRouter} from "../../src/interfaces/ISettlementRouter.sol";
import {IWindowBook} from "../../src/interfaces/IWindowBook.sol";
import {Mirror} from "../../src/l2/Mirror.sol";
import {OrderStatus, Profile} from "../../src/l2/WindowBook.sol";
import {PoolState, Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {FrameFixture} from "./FrameFixture.sol";

/// @notice Leg parity, end to end — RD-2 TS-1, TS-3, CT-9, SV-2.
/// @dev `contracts/test/l2/fixtures/leg-parity.json` is the one fixture two
/// packages share: WP-2 asserts its book builds this leg, WP-3 asserts its
/// window builder simulates the same one. Both did so against a stub of the
/// L1 side. This asserts the third thing, which is the one that matters at
/// settlement: **the leg those two agree on is the leg the real router
/// receives**, and the `WindowResult` it returns drives the crossing, the
/// impact allocation and CT-10 exactly as the mocked suites assumed.
///
/// The venue's fee tier is zero here, so `Mirror` — the settler's simulator
/// and the book's quote — is exactly the curve the pool walks. That makes the
/// leg's output assertable to the wei rather than approximately.
contract LegParityTest is FrameFixture {
    /// @dev Alice: 10 A at a 19,000 B limit. Bob: 10,000 B at a 4.9 A limit.
    uint256 private constant SELL_A = 10e18;
    uint256 private constant MIN_BUY_A = 19_000e18;
    uint256 private constant SELL_B = 10_000e18;
    uint256 private constant MIN_BUY_B = 4.9e18;

    /// @dev The fixture's `expectedLeg`, transcribed. A change to either side
    /// of the leg-parity contract has to change these too.
    uint256 private constant RESIDUAL_IN = 4_999_500_000_000_000_000;
    uint256 private constant MIN_PRICE_X96 = 150_548_563_633_465_587_986_532_158_854_286;
    uint256 private constant MAX_PRICE_X96 = 161_673_958_567_373_288_081_193_052_940_747;
    uint256 private constant CROSSED_IN_A = 4_999_500_000_000_000_000;
    uint256 private constant NET_IN_A = 9_999_000_000_000_000_000;
    uint256 private constant NET_IN_B = 9_999_000_000_000_000_000_000;
    /// @dev The fixture's `spotPriceX96`: 2000 B per A as the square of the
    /// snapshot's `sqrtPriceX96`, which is where every price in the window is
    /// read from — not 2000 * 2**96, which no `sqrtPriceX96` represents.
    uint256 private constant SPOT_PRICE_X96 = 158_456_325_028_528_675_187_087_900_671_953;

    function setUp() public {
        _deployFrame(Profile.FULL, Pair.TOKEN_TOKEN);
    }

    /// @dev The fixture's mirror is this pool's state, or the numbers below
    /// describe a different window than the one that settles.
    function test_ts1_the_fixture_mirror_is_the_pool_the_leg_swaps_against() public view {
        PoolState memory state = _poolState();
        assertEq(state.sqrtPriceX96, 3_543_191_142_285_914_205_922_034_323_214, "leg-parity: mirror sqrtPriceX96");
        assertEq(state.liquidity, 44_721_359_549_995_793_928_183, "leg-parity: mirror liquidity");
        assertEq(Mirror.spotPriceX96(state), SPOT_PRICE_X96, "leg-parity: 2000 B per A");
        assertEq(_spotPriceX96(), SPOT_PRICE_X96, "the venue quotes the same price the mirror does");
    }

    /// @dev TS-1 and TS-3's shared fixture, all the way to L1.
    function test_ts1_the_router_receives_the_leg_the_fixture_pins() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, MIN_BUY_A);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, MIN_BUY_B);

        WindowLeg[] memory expected = new WindowLeg[](1);
        expected[0] = WindowLeg({
            windowId: 0,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: RESIDUAL_IN,
            minPriceX96: MIN_PRICE_X96,
            maxPriceX96: MAX_PRICE_X96,
            deadline: START_TIME + DEADLINE_SECONDS,
            distribution: "" // [full] delivery is the bridge's, so the leg carries none
        });

        // Not "a call was made with these fields" but "this calldata reached
        // the router": the leg is abi-encoded on L2 and decoded on L1, and
        // this is the encoding both sides have to agree on.
        vm.expectCall(address(router), abi.encodeCall(ISettlementRouter.settle, (expected)));
        _settle(_ids(a, b));

        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.FILLED));
    }

    /// @dev The result the mocked suites crafted, produced instead: `P0` is
    /// the pool's pre-trade spot, the output is the curve's, the crossed order
    /// clears at `P0` and pays no impact, and the residual side takes the
    /// crossed pot plus the leg and carries the whole impact (FL-4, FL-5).
    function test_ct9_the_real_result_drives_crossing_and_impact() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, MIN_BUY_A);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, MIN_BUY_B);

        // What the settler's simulator says this leg does, before it does it.
        (, uint256 simulated) = Mirror.advance(_poolState(), RESIDUAL_IN, Side.SELL_A_FOR_B);

        vm.recordLogs();
        _settle(_ids(a, b));
        (WindowResult memory result, uint256[] memory fills, uint256[] memory impacts) = _settlement();

        assertEq(result.referencePriceX96, SPOT_PRICE_X96, "CT-2: P0 is the pool's pre-trade spot");
        assertEq(result.amountIn, RESIDUAL_IN, "the leg swapped the residual the book netted");
        assertEq(result.amountOut, simulated, "SV-2: the venue's output is the one Mirror simulated");
        assertLt(result.executionPriceX96, result.referencePriceX96, "the residual moved the price against itself");

        // Bob crossed: he is paid out of the A side's escrow at the mirror
        // price, which is `P0` here, and pays no impact.
        assertEq(fills[1], CROSSED_IN_A, "FL-5: the crossed order clears at the reference price");
        assertEq(impacts[1], 0, "FL-5: a crossed order pays no impact");
        assertEq(_balance(assetA, bob), CROSSED_IN_A, "CT-11: delivered to an L2 balance");
        assertGe(fills[1], MIN_BUY_B, "CT-10: at or above the limit");

        // Alice is the whole residual side: the crossed side's B plus the
        // leg's output, less the impact she caused.
        assertEq(fills[0], NET_IN_B + result.amountOut, "FL-5: the residual side takes both pots");
        assertEq(
            impacts[0],
            NET_IN_A - Math.mulDiv(fills[0], Q96, result.referencePriceX96),
            "CT-12: impact is the input that bought nothing at P0"
        );
        assertGe(fills[0], MIN_BUY_A, "CT-10: at or above the limit");

        _assertEscrowInvariant();
        _assertReserveInvariant();
    }

    /// @dev CT-10 is the contract's last check and it is checked against the
    /// price the *leg* achieved: a drift that leaves the band intact but the
    /// crossed order's limit unmet reverts the whole frame (FL-7).
    function test_ct10_a_fill_below_the_limit_reverts_the_settled_frame() public {
        // Bob's limit is 5.0 A for 10,000 B — met exactly at the mirror price
        // before fees, and so not met after them.
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, SELL_A, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, SELL_B, 5e18);
        uint64 deadline = uint64(block.timestamp) + DEADLINE_SECONDS;

        vm.prank(settler);
        vm.expectRevert();
        book.settleWindow(_ids(a, b), deadline);

        assertEq(book.windowId(), 0, "the window did not advance");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "the order is still open");
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.OPEN), "the order is still open");
        _assertEscrowInvariant();
        _assertReserveInvariant();
    }

    // ------------------------------------------------------------------ helpers ---

    /// @dev The settlement, read back out of the logs the way the indexer
    /// reads it (IX-2): one `WindowSettled` and one `OrderFilled` per order,
    /// in selection order.
    function _settlement()
        private
        returns (WindowResult memory result, uint256[] memory fills, uint256[] memory impacts)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        fills = new uint256[](2);
        impacts = new uint256[](2);
        uint256 n;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == IWindowBook.WindowSettled.selector) {
                result = abi.decode(logs[i].data, (WindowResult));
            } else if (logs[i].topics[0] == IWindowBook.OrderFilled.selector) {
                (uint256 amountOut,,, uint256 impactAmount) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                fills[n] = amountOut;
                impacts[n] = impactAmount;
                ++n;
            }
        }
        assertEq(n, 2, "one OrderFilled per order");
    }
}
