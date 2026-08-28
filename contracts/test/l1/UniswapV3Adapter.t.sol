// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {PoolState, Side} from "../../src/types/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPool} from "../mocks/MockPool.sol";

/// @notice TS-1 for the venue behind `IPoolAdapter` (CT-3): state reads, the
/// exact-input swap, its callback, and the calling convention the router
/// depends on — input pushed here, output paid to the caller.
contract UniswapV3AdapterTest is Test {
    uint256 internal constant Q96 = 1 << 96;
    uint24 internal constant POOL_FEE = 3000;
    uint128 internal constant POOL_LIQUIDITY = 1e24;
    uint160 internal constant POOL_SQRT_PRICE = uint160(2 * Q96);

    MockERC20 internal token0;
    MockERC20 internal token1;
    MockPool internal pool;
    /// @dev A is `token0` here; `adapterInverted` is the same pool read the
    /// other way round, which is the only thing that changes between them.
    UniswapV3Adapter internal adapter;
    UniswapV3Adapter internal adapterInverted;

    function setUp() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = new MockPool(address(token0), address(token1), POOL_FEE, POOL_SQRT_PRICE, POOL_LIQUIDITY);
        token0.mint(address(pool), 1e30);
        token1.mint(address(pool), 1e30);

        adapter = new UniswapV3Adapter(address(pool), address(token0));
        adapterInverted = new UniswapV3Adapter(address(pool), address(token1));
    }

    function test_ct3_reports_the_pair_in_the_pools_own_order() public view {
        assertEq(adapter.tokenA(), address(token0), "A as configured");
        assertEq(adapter.tokenB(), address(token1), "B is the other one");
        assertEq(adapterInverted.tokenA(), address(token1), "and the other way round");
        assertEq(adapterInverted.tokenB(), address(token0), "and the other way round");
    }

    function test_ct3_constructor_rejects_a_token_the_pool_does_not_hold() public {
        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.UnknownToken.selector, address(stranger)));
        new UniswapV3Adapter(address(pool), address(stranger));
    }

    function test_ct3_quote_state_matches_the_pool() public view {
        PoolState memory state = adapter.quoteState();
        (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();
        assertEq(state.sqrtPriceX96, sqrtPriceX96, "sqrt price");
        assertEq(state.liquidity, pool.liquidity(), "in-range liquidity");
        assertEq(state.tick, tick, "tick");
    }

    function test_ct3_quote_state_follows_the_pool() public {
        pool.setSqrtPriceX96(uint160(3 * Q96));
        pool.setLiquidity(5e23);

        PoolState memory state = adapter.quoteState();
        assertEq(state.sqrtPriceX96, uint160(3 * Q96), "a moved pool reads moved");
        assertEq(state.liquidity, 5e23, "and so does its liquidity");
    }

    function test_ct3_swap_sells_a_for_b_and_pays_its_caller() public {
        uint256 amountIn = 1 ether;
        token0.mint(address(adapter), amountIn);

        uint160 before = pool.sqrtPriceX96();
        uint256 amountOut = adapter.swap(Side.SELL_A_FOR_B, amountIn, 0);

        assertEq(token1.balanceOf(address(this)), amountOut, "the output goes to the caller");
        assertEq(token0.balanceOf(address(adapter)), 0, "the input is fully paid to the pool");
        assertLt(pool.sqrtPriceX96(), before, "selling token0 moves the curve down");
    }

    function test_ct3_swap_sells_b_for_a_and_pays_its_caller() public {
        uint256 amountIn = 1 ether;
        token1.mint(address(adapter), amountIn);

        uint160 before = pool.sqrtPriceX96();
        uint256 amountOut = adapter.swap(Side.SELL_B_FOR_A, amountIn, 0);

        assertEq(token0.balanceOf(address(this)), amountOut, "the output goes to the caller");
        assertEq(token1.balanceOf(address(adapter)), 0, "the input is fully paid to the pool");
        assertGt(pool.sqrtPriceX96(), before, "selling token1 moves the curve up");
    }

    /// @dev The same trade through the inverted adapter is the same trade: A
    /// and B name the pair, not the pool's ordering.
    function test_ct3_the_inverted_adapter_sells_the_other_token() public {
        uint256 amountIn = 1 ether;
        token1.mint(address(adapterInverted), amountIn);

        uint160 before = pool.sqrtPriceX96();
        uint256 amountOut = adapterInverted.swap(Side.SELL_A_FOR_B, amountIn, 0);

        assertEq(token0.balanceOf(address(this)), amountOut, "A is token1 here, so B is token0");
        assertGt(pool.sqrtPriceX96(), before, "and selling it moves the curve up");
    }

    function test_ct3_swap_reverts_below_min_out() public {
        uint256 amountIn = 1 ether;
        token0.mint(address(adapter), amountIn);

        uint256 expected = _quoteOut(Side.SELL_A_FOR_B, amountIn);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.InsufficientOutput.selector, expected, expected + 1));
        adapter.swap(Side.SELL_A_FOR_B, amountIn, expected + 1);
    }

    function test_ct3_swap_rejects_an_amount_the_pool_cannot_signal() public {
        uint256 amountIn = uint256(type(int256).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.AmountTooLarge.selector, amountIn));
        adapter.swap(Side.SELL_A_FOR_B, amountIn, 0);
    }

    function testFuzz_ct3_callback_rejects_a_caller_that_is_not_the_pool(address caller) public {
        vm.assume(caller != address(pool));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Adapter.NotPool.selector, caller));
        adapter.uniswapV3SwapCallback(1, -1, abi.encode(true));
    }

    function _quoteOut(Side side, uint256 amountIn) internal returns (uint256 amountOut) {
        uint256 snapshot = vm.snapshotState();
        MockERC20(side == Side.SELL_A_FOR_B ? token0 : token1).mint(address(adapter), amountIn);
        amountOut = adapter.swap(side, amountIn, 0);
        vm.revertToState(snapshot);
    }
}
