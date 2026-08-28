// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolAdapter} from "../../interfaces/IPoolAdapter.sol";
import {PoolState, Side} from "../../types/Types.sol";
import {IUniswapV3Pool} from "./IUniswapV3Pool.sol";

/// @title The first venue behind IPoolAdapter (WP-1, CT-3).
/// @notice Every Uniswap v3 assumption in the DEX lives here: the `slot0`
/// layout, the sorted `token0 < token1` ordering, the exact-input swap and its
/// callback, and the price-limit sentinels. A second venue is a new adapter
/// beside this one, never a change to `SettlementRouter`.
///
/// **Calling convention.** `IPoolAdapter.swap` takes no payer and no
/// recipient, so the router pushes the leg's input to this contract and the
/// pool sends the output straight back to `msg.sender`. The adapter therefore
/// holds a balance only inside the frame that funded it: it is stateless
/// between settlements and custodies nothing.
contract UniswapV3Adapter is IPoolAdapter {
    using SafeERC20 for IERC20;

    /// @notice `tokenA_` is neither of the pool's tokens.
    error UnknownToken(address token);
    /// @notice The swap callback was not made by the configured pool.
    error NotPool(address caller);
    /// @notice `amountIn` does not fit the pool's signed delta.
    error AmountTooLarge(uint256 amountIn);
    /// @notice The pool consumed less than the whole residual — the leg would
    /// settle a different amount than `WindowBook` netted, so it reverts.
    error PartialSwap(uint256 consumed, uint256 amountIn);
    /// @notice The swap's output is below the band-derived floor (CT-1).
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    /// @dev The v3 price domain; ±1 is "no limit" in the swap's direction.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @notice The target pool. One venue, one pair family at launch (§11).
    IUniswapV3Pool public immutable pool;
    /// @notice The pair's A asset — the one `Side.SELL_A_FOR_B` sells.
    address public immutable tokenA;
    /// @notice The pair's B asset — prices are B per A in Q96 (A.1).
    address public immutable tokenB;

    /// @dev True when A is the pool's `token0`, i.e. when selling A moves the
    /// pool's price down. Fixed at deployment from the pool's own ordering.
    bool internal immutable A_IS_TOKEN0;

    constructor(address pool_, address tokenA_) {
        pool = IUniswapV3Pool(pool_);
        address token0 = IUniswapV3Pool(pool_).token0();
        address token1 = IUniswapV3Pool(pool_).token1();

        if (tokenA_ == token0) {
            A_IS_TOKEN0 = true;
            tokenB = token1;
        } else if (tokenA_ == token1) {
            A_IS_TOKEN0 = false;
            tokenB = token0;
        } else {
            revert UnknownToken(tokenA_);
        }
        tokenA = tokenA_;
    }

    /// @inheritdoc IPoolAdapter
    function quoteState() external view returns (PoolState memory state) {
        (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();
        state = PoolState({sqrtPriceX96: sqrtPriceX96, liquidity: pool.liquidity(), tick: tick});
    }

    /// @inheritdoc IPoolAdapter
    /// @dev Exact input, no price limit: the band check on the realised price
    /// is the router's protection (CT-1), and a limit that bound the swap
    /// would leave part of the residual unswapped, which `PartialSwap`
    /// rejects. The input must already be held by this contract.
    function swap(Side side, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge(amountIn);
        bool zeroForOne = (side == Side.SELL_A_FOR_B) == A_IS_TOKEN0;

        (int256 amount0, int256 amount1) = pool.swap(
            msg.sender,
            zeroForOne,
            // casting to 'int256' is safe because amountIn was just bounded by int256 max
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(zeroForOne)
        );

        (int256 inDelta, int256 outDelta) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        // casting to 'uint256' is safe because the pool's input delta is positive and its output delta negative
        // forge-lint: disable-start(unsafe-typecast)
        uint256 consumed = uint256(inDelta);
        amountOut = uint256(-outDelta);
        // forge-lint: disable-end(unsafe-typecast)

        if (consumed != amountIn) revert PartialSwap(consumed, amountIn);
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
    }

    /// @notice Pays the pool the input it just took the output against.
    /// @dev The v3 pool sends the output first and collects here; the payment
    /// comes from this contract's own balance, which the router funded before
    /// calling `swap`.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != address(pool)) revert NotPool(msg.sender);
        bool zeroForOne = abi.decode(data, (bool));
        int256 owed = zeroForOne ? amount0Delta : amount1Delta;
        if (owed <= 0) return;

        address tokenIn = zeroForOne ? pool.token0() : pool.token1();
        // casting to 'uint256' is safe because `owed` was just checked positive
        // forge-lint: disable-next-line(unsafe-typecast)
        IERC20(tokenIn).safeTransfer(msg.sender, uint256(owed));
    }
}
