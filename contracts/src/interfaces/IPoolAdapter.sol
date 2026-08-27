// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PoolState, Side} from "../types/Types.sol";

/// @title One venue behind one interface — RD-2 CT-3, A.3.
/// @notice FROZEN AT THE SCAFFOLD. Uniswap v3 is the first implementation
/// (WP-1); a second venue is a new adapter, not a router change.
interface IPoolAdapter {
    /// @notice The pool's current state: sqrt price, in-range liquidity, tick.
    /// @dev Read inside the L1 leg immediately before the swap to derive `P0`.
    function quoteState() external view returns (PoolState memory state);

    /// @notice Swaps `amountIn` of the `side`'s sell asset for at least
    /// `minOut` of the other.
    /// @dev Prices derived from this call are B per A in Q96 regardless of
    /// `side` (CT-2).
    function swap(Side side, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut);
}
