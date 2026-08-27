// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "./MockERC20.sol";
import {IUniswapV3SwapCallback, MockPool} from "./MockPool.sol";

/// @dev Pays a MockPool swap the way a router does: the pool hands the output
/// over first, then calls back for the input.
contract SwapPayer is IUniswapV3SwapCallback {
    MockPool internal immutable POOL;

    constructor(MockPool pool) {
        POOL = pool;
    }

    function swap(bool zeroForOne, uint256 amountIn, uint160 limit) external returns (uint256 amountOut) {
        require(amountIn <= uint256(type(int256).max), "amountIn too large");
        // forge-lint: disable-start(unsafe-typecast)
        // the casts are safe because amountIn is bounded above and the pool
        // always returns the output leg negative
        (int256 amount0, int256 amount1) = POOL.swap(address(this), zeroForOne, int256(amountIn), limit, "");
        return zeroForOne ? uint256(-amount1) : uint256(-amount0);
        // forge-lint: disable-end(unsafe-typecast)
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == address(POOL), "unexpected callback");
        // forge-lint: disable-start(unsafe-typecast)
        // casting to 'uint256' is safe because each branch is guarded positive
        if (amount0Delta > 0) require(MockERC20(POOL.token0()).transfer(msg.sender, uint256(amount0Delta)), "pay 0");
        if (amount1Delta > 0) require(MockERC20(POOL.token1()).transfer(msg.sender, uint256(amount1Delta)), "pay 1");
        // forge-lint: disable-end(unsafe-typecast)
    }
}

/// @notice HX-1: the mock pool's swap really moves the price along a curve.
/// These pin the frozen fixture WP-1 unit-tests its adapter against and WP-4
/// deploys into the enclave.
contract MockPoolTest is Test {
    uint256 internal constant Q96 = 0x1000000000000000000000000;
    uint160 internal constant SQRT_PRICE_ONE = 79228162514264337593543950336; // tick 0
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint128 internal constant LIQUIDITY = 1e21;

    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    function _pool(uint24 fee) internal returns (MockPool pool, SwapPayer payer) {
        pool = new MockPool(address(tokenA), address(tokenB), fee, SQRT_PRICE_ONE, LIQUIDITY);
        payer = new SwapPayer(pool);
        tokenA.mint(address(pool), 1e24);
        tokenB.mint(address(pool), 1e24);
        tokenA.mint(address(payer), 1e24);
        tokenB.mint(address(payer), 1e24);
    }

    function setUp() public {
        MockERC20 first = new MockERC20("Token A", "A", 18);
        MockERC20 second = new MockERC20("Token B", "B", 18);
        (tokenA, tokenB) = address(first) < address(second) ? (first, second) : (second, first);
    }

    function _spotX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        return Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
    }

    /// @dev An exact-input swap always executes between the spot price it
    /// started at and the spot price it ended at. That is what "moves along a
    /// curve" means, and it is the property the residual's impact is derived
    /// from (FL-5).
    function test_hx1_swap_executes_between_pre_and_post_spot() public {
        (MockPool pool, SwapPayer payer) = _pool(0);
        uint256 before = _spotX96(pool.sqrtPriceX96());

        uint256 amountIn = 1e18;
        uint256 amountOut = payer.swap(true, amountIn, MIN_SQRT_RATIO + 1);
        uint256 after_ = _spotX96(pool.sqrtPriceX96());
        uint256 execX96 = Math.mulDiv(amountOut, Q96, amountIn);

        assertLt(after_, before, "selling token0 must lower the price");
        assertLt(execX96, before, "execution cannot beat the pre-trade spot");
        assertGt(execX96, after_, "execution cannot be worse than the post-trade spot");
    }

    /// @dev Impact grows with size: a swap ten times larger executes worse.
    function test_hx1_larger_residual_executes_worse() public {
        (MockPool small, SwapPayer smallPayer) = _pool(0);
        (MockPool large, SwapPayer largePayer) = _pool(0);

        uint256 smallOut = smallPayer.swap(true, 1e18, MIN_SQRT_RATIO + 1);
        uint256 largeOut = largePayer.swap(true, 10e18, MIN_SQRT_RATIO + 1);

        assertLt(
            Math.mulDiv(largeOut, Q96, 10e18),
            Math.mulDiv(smallOut, Q96, 1e18),
            "ten times the size must execute at a worse average price"
        );
        assertLt(large.sqrtPriceX96(), small.sqrtPriceX96(), "the larger swap must move the price further");
    }

    function test_hx1_fee_tier_is_charged_on_the_input() public {
        (, SwapPayer free) = _pool(0);
        (, SwapPayer charged) = _pool(3000);

        uint256 freeOut = free.swap(true, 1e18, MIN_SQRT_RATIO + 1);
        uint256 chargedOut = charged.swap(true, 1e18, MIN_SQRT_RATIO + 1);

        assertLt(chargedOut, freeOut, "a 0.30% pool must return less than a 0% pool");
        assertApproxEqRel(chargedOut, (freeOut * 997) / 1000, 1e15, "fee is ~0.30% of the input");
    }

    function test_hx1_price_limit_stops_the_swap() public {
        (MockPool pool, SwapPayer payer) = _pool(0);
        // A limit one tick below spot: the swap may only consume what reaching
        // it costs, exactly as a real pool does.
        uint160 limit = 79_224_201_403_219_477_606_790_721_721; // tick -1
        uint256 balanceBefore = tokenA.balanceOf(address(payer));

        payer.swap(true, 1e21, limit);

        assertEq(pool.sqrtPriceX96(), limit, "the swap must stop at the limit");
        assertLt(balanceBefore - tokenA.balanceOf(address(payer)), 1e21, "input beyond the limit is not consumed");
    }

    function test_hx1_swap_the_other_way_raises_the_price() public {
        (MockPool pool, SwapPayer payer) = _pool(0);
        uint256 out = payer.swap(false, 1e18, MAX_SQRT_RATIO - 1);
        assertGt(pool.sqrtPriceX96(), SQRT_PRICE_ONE, "selling token1 must raise the price");
        assertGt(out, 0, "a swap must return something");
    }

    function test_hx1_price_and_liquidity_are_settable() public {
        (MockPool pool,) = _pool(0);
        uint160 moved = 79_625_275_426_524_704_953_415_043_837; // tick 100
        pool.setSqrtPriceX96(moved);
        pool.setLiquidity(5e20);
        (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();
        assertEq(sqrtPriceX96, moved);
        assertEq(pool.liquidity(), 5e20);
        assertApproxEqAbs(int256(tick), int256(100), 1, "tick follows the price");
    }

    function test_hx1_tick_matches_the_price() public {
        (MockPool pool,) = _pool(0);
        assertEq(pool.tickAtSqrtRatio(SQRT_PRICE_ONE), int24(0), "a price of 1 is tick 0");
        assertApproxEqAbs(int256(pool.tickAtSqrtRatio(79_625_275_426_524_704_953_415_043_837)), int256(100), 1);
        assertApproxEqAbs(int256(pool.tickAtSqrtRatio(78_833_030_112_140_219_982_555_770_494)), int256(-100), 1);
        assertApproxEqAbs(
            int256(pool.tickAtSqrtRatio(1_927_678_248_327_703_324_616_387_877_822_486)), int256(202_000), 1
        );
    }

    /// @dev Monotonic across the whole domain: a higher price is never a lower
    /// tick. Fuzzing this is what makes the derived tick trustworthy.
    function testFuzz_hx1_tick_is_monotonic(uint160 a, uint160 b) public {
        (MockPool pool,) = _pool(0);
        a = uint160(bound(a, MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1));
        b = uint160(bound(b, MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1));
        if (a > b) (a, b) = (b, a);
        assertLe(pool.tickAtSqrtRatio(a), pool.tickAtSqrtRatio(b));
    }

    function test_hx1_rejects_exact_output_and_a_price_out_of_range() public {
        (MockPool pool, SwapPayer payer) = _pool(0);
        vm.expectRevert(MockPool.InvalidAmount.selector);
        pool.swap(address(payer), true, -1e18, MIN_SQRT_RATIO + 1, "");
        vm.expectRevert(MockPool.InvalidPriceLimit.selector);
        pool.swap(address(payer), true, 1e18, SQRT_PRICE_ONE, "");
        vm.expectRevert(MockPool.PriceOutOfRange.selector);
        pool.setSqrtPriceX96(1);
    }
}
