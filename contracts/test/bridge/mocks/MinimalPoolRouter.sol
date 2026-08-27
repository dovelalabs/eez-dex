// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Credit, IDexBridge} from "../../../src/interfaces/IDexBridge.sol";

interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    )
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice The middle of the settlement frame, reduced to the part `DexBridge`
/// needs: swap the released sell side against a real pool and hand the bought
/// asset to `deposit` for L2 credit.
/// @dev Deliberately *not* `SettlementRouter` — WP-1 owns that on a parallel
/// branch, and the real `release` -> `settle` -> `deposit` -> `WindowBook` path
/// is wired and validated in Phase 6. This is a direct pool call and nothing
/// more, so TS-B's fork test does not depend on WP-1's shape.
contract MinimalPoolRouter {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IDexBridge public immutable BRIDGE;
    IUniswapV3PoolMinimal public immutable POOL;

    error OnlyPool();

    constructor(IDexBridge bridge_, IUniswapV3PoolMinimal pool_) {
        BRIDGE = bridge_;
        POOL = pool_;
    }

    /// @notice Swaps `amountIn` of `tokenIn` and deposits everything bought for
    /// `recipient`'s L2 credit.
    function swapAndDeposit(
        address tokenIn,
        uint256 amountIn,
        address recipient
    )
        external
        returns (address tokenOut, uint256 amountOut)
    {
        bool zeroForOne = tokenIn == POOL.token0();
        tokenOut = zeroForOne ? POOL.token1() : POOL.token0();

        (int256 amount0, int256 amount1) = POOL.swap(
            address(this),
            zeroForOne,
            amountIn.toInt256(),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        // casting to 'uint256' is safe because the pool reports the output leg
        // as a negative delta, so its negation is positive
        // forge-lint: disable-next-line(unsafe-typecast)
        amountOut = uint256(-(zeroForOne ? amount1 : amount0));

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: recipient, amount: amountOut});
        IERC20(tokenOut).safeTransfer(address(BRIDGE), amountOut);
        BRIDGE.deposit(tokenOut, amountOut, credits);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != address(POOL)) revert OnlyPool();
        address tokenIn = abi.decode(data, (address));
        // casting to 'uint256' is safe because exactly one delta is the
        // positive input leg and the ternary selects it
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }
}
