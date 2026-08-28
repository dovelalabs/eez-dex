// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {IUniswapV3SwapCallback, MockPool} from "../mocks/MockPool.sol";
import {Mirror} from "../../src/l2/Mirror.sol";
import {PoolState, Side} from "../../src/types/Types.sol";

/// @dev Pays the pool for a swap, so the mock behaves as a real v3 pool does.
contract SwapCaller is IUniswapV3SwapCallback {
    MockPool private immutable POOL;

    constructor(MockPool pool) {
        POOL = pool;
    }

    function swap(bool zeroForOne, uint256 amountIn, uint160 limit) external returns (uint256 amountOut) {
        // casting to 'int256' is safe because test amounts are far below int256 max
        // forge-lint: disable-next-line(unsafe-typecast)
        (int256 amount0, int256 amount1) = POOL.swap(address(this), zeroForOne, int256(amountIn), limit, "");
        return zeroForOne ? uint256(-amount1) : uint256(-amount0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) MockERC20(POOL.token0()).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) MockERC20(POOL.token1()).transfer(msg.sender, uint256(amount1Delta));
    }
}

/// @dev `expectRevert` needs a call boundary, and a library's `internal` functions do
/// not make one. This is that boundary and nothing else.
contract MirrorHarness {
    function quote(PoolState memory state, uint256 sellAmount, Side side) external pure returns (uint256) {
        return Mirror.quote(state, sellAmount, side);
    }

    function valueIn(uint256 amount, uint256 priceX96, Side side) external pure returns (uint256) {
        return Mirror.valueIn(amount, priceX96, side);
    }

    function spotPriceX96(PoolState memory state) external pure returns (uint256) {
        return Mirror.spotPriceX96(state);
    }
}

/// @notice TS-1 — quote maths against the `Mirror` library.
/// @dev The load-bearing claim is that the mirror is a *working copy* of the pool: an L2
/// quote and the L1 swap it anticipates must be the same arithmetic (RD-2 §3), so these
/// tests run `Mirror.quote` and `MockPool.swap` over identical state and compare, rather
/// than comparing the library to a second copy of its own formula.
contract MirrorTest is Test {
    uint256 private constant Q96 = 0x1000000000000000000000000;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    MockPool private pool;
    SwapCaller private caller;
    MirrorHarness private harness;
    MockERC20 private token0;
    MockERC20 private token1;

    uint128 private constant LIQUIDITY = 44_721_359_549_995_793_928_183; // sqrt(1000e18 * 2e24)

    function setUp() public {
        MockERC20 first = new MockERC20("T0", "T0", 18);
        MockERC20 second = new MockERC20("T1", "T1", 18);
        (token0, token1) = address(first) < address(second) ? (first, second) : (second, first);

        // Fee tier zero: `Mirror` models the curve, not the venue's fee schedule, so a
        // parity test has to compare like with like.
        pool = new MockPool(address(token0), address(token1), 0, _sqrtPriceFor(2000 * Q96), LIQUIDITY);
        caller = new SwapCaller(pool);
        harness = new MirrorHarness();

        token0.mint(address(pool), 1e30);
        token1.mint(address(pool), 1e30);
        token0.mint(address(caller), 1e30);
        token1.mint(address(caller), 1e30);
    }

    // ------------------------------------------------------------ CT-2 · prices ---

    function test_ct2_spot_price_is_b_per_a_in_q96() public pure {
        PoolState memory state = _state(2000 * Q96);
        // The round trip through a 160-bit square root costs a wei of precision, not a
        // basis point.
        assertApproxEqRel(Mirror.spotPriceX96(state), 2000 * Q96, 1e6, "spot price");
    }

    function test_ct2_value_in_is_symmetric_across_side() public pure {
        uint256 priceX96 = 2000 * Q96;
        assertEq(Mirror.valueIn(3e18, priceX96, Side.SELL_A_FOR_B), 6000e18, "A valued in B");
        assertEq(Mirror.valueIn(6000e18, priceX96, Side.SELL_B_FOR_A), 3e18, "B valued in A");
    }

    function test_ct12_value_in_rounds_down() public pure {
        // 1 wei of A at 2000.5 B per A is 2000 B and a half; the user gets 2000.
        uint256 priceX96 = 2000 * Q96 + Q96 / 2;
        assertEq(Mirror.valueIn(1, priceX96, Side.SELL_A_FOR_B), 2000, "rounded down");
    }

    function test_uninitialised_mirror_cannot_be_quoted() public {
        PoolState memory empty;
        vm.expectRevert(Mirror.UninitialisedMirror.selector);
        harness.quote(empty, 1e18, Side.SELL_A_FOR_B);
    }

    function test_no_liquidity_cannot_be_quoted() public {
        PoolState memory state = _state(2000 * Q96);
        state.liquidity = 0;
        vm.expectRevert(Mirror.NoLiquidity.selector);
        harness.quote(state, 1e18, Side.SELL_A_FOR_B);
    }

    /// @dev Regression: `post = state` on a memory struct aliases rather than copies, so
    /// `advance` used to move the very snapshot it was asked to read — which silently
    /// left the caller quoting against a post-trade mirror (FL-1).
    function test_advance_does_not_move_the_snapshot_it_was_given() public pure {
        PoolState memory state = _state(2000 * Q96);
        uint160 sqrtBefore = state.sqrtPriceX96;

        (PoolState memory post,) = Mirror.advance(state, 5e18, Side.SELL_A_FOR_B);

        assertEq(state.sqrtPriceX96, sqrtBefore, "the snapshot must not move");
        assertLt(post.sqrtPriceX96, sqrtBefore, "the copy must carry the swap");
    }

    // ------------------------------------------------------- CT-8 · quote maths ---

    function test_ct8_quote_equals_the_pool_for_a_sell() public {
        uint256 amountIn = 5e18;
        uint256 expected = Mirror.quote(_state(2000 * Q96), amountIn, Side.SELL_A_FOR_B);
        uint256 actual = caller.swap(true, amountIn, MIN_SQRT_RATIO + 1);
        assertEq(actual, expected, "CT-8: quote must equal the pool's own curve");
    }

    function test_ct8_quote_equals_the_pool_for_b_sell() public {
        uint256 amountIn = 10_000e18;
        uint256 expected = Mirror.quote(_state(2000 * Q96), amountIn, Side.SELL_B_FOR_A);
        uint256 actual = caller.swap(false, amountIn, MAX_SQRT_RATIO - 1);
        assertEq(actual, expected, "CT-8: quote must equal the pool's own curve");
    }

    function testFuzz_ct8_quote_equals_the_pool(uint96 amountIn, bool sellA) public {
        vm.assume(amountIn > 1e12);
        Side side = sellA ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
        uint256 expected = Mirror.quote(_state(2000 * Q96), amountIn, side);
        uint256 actual = caller.swap(sellA, amountIn, sellA ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1);
        assertEq(actual, expected, "CT-8: quote must equal the pool's own curve");
    }

    function test_ct8_advance_leaves_the_pool_state_the_swap_leaves() public {
        uint256 amountIn = 5e18;
        (PoolState memory post,) = Mirror.advance(_state(2000 * Q96), amountIn, Side.SELL_A_FOR_B);
        caller.swap(true, amountIn, MIN_SQRT_RATIO + 1);
        assertEq(post.sqrtPriceX96, pool.sqrtPriceX96(), "post-trade state must match the pool");
    }

    /// @dev The curve is the reason the residual side pays impact (FL-5): a quote must
    /// never beat the spot valuation, or the mirror would promise what L1 cannot deliver.
    function testFuzz_ct12_quote_never_beats_the_spot_valuation(uint96 amountIn, bool sellA) public pure {
        vm.assume(amountIn > 0);
        PoolState memory state = _state(2000 * Q96);
        Side side = sellA ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
        assertLe(
            Mirror.quote(state, amountIn, side),
            Mirror.valueIn(amountIn, Mirror.spotPriceX96(state), side),
            "impact must never be negative"
        );
    }

    function test_quote_of_nothing_is_nothing() public pure {
        assertEq(Mirror.quote(_state(2000 * Q96), 0, Side.SELL_A_FOR_B), 0);
    }

    // --------------------------------------------------------- CT-8 · mirror age ---

    function test_ct8_age_is_whole_l1_slots() public pure {
        assertEq(Mirror.ageSlots(1000, 1000), 0, "same instant");
        assertEq(Mirror.ageSlots(1011, 1000), 0, "11 s is not a slot yet");
        assertEq(Mirror.ageSlots(1012, 1000), 1, "one slot");
        assertEq(Mirror.ageSlots(1060, 1000), 5, "five slots");
    }

    function test_ct8_age_of_an_unstamped_or_future_mirror_is_zero() public pure {
        assertEq(Mirror.ageSlots(1000, 0), 0, "never stamped");
        assertEq(Mirror.ageSlots(1000, 2000), 0, "stamped ahead");
    }

    // ------------------------------------------------------------------ helpers ---

    function _state(uint256 priceX96) private pure returns (PoolState memory) {
        return PoolState({sqrtPriceX96: _sqrtPriceFor(priceX96), liquidity: LIQUIDITY, tick: 0});
    }

    function _sqrtPriceFor(uint256 priceX96) private pure returns (uint160) {
        // casting to 'uint160' is safe because the prices here are far inside the v3
        // domain
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(priceX96 * Q96));
    }
}
