// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolState, Side} from "../types/Types.sol";

/// @title Mirror — pure pricing over a snapshot of pool state (WP-2, FL-1, CT-8).
/// @notice A library, not a contract: the same quote and clearing-price maths the
/// settler's simulator runs, so an on-chain quote and an off-chain one cannot drift
/// (RD-2 §3).
///
/// **Orientation.** The pair is `(A, B)` where **A is the pool's `token0` and B its
/// `token1`**, so a price is `token1` per `token0` — B per A in Q96, regardless of
/// `Side`, exactly as `Types.sol` requires. A deployment orients its pair to match the
/// pool it mirrors; nothing here reads a token address.
///
/// What is modelled: the constant-product curve of a v3 range that spans every price,
/// which is what `MockPool` (HX-1) implements and what a real pool does inside one tick.
/// There are no ticks to cross and no fee tier in a `PoolState`, so a quote is
/// indicative (FL-2) — the binding price is always the one the L1 leg returns (CT-2).
library Mirror {
    /// @notice `2**96`. Every price in this repository is Q96.
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice One L1 slot. The L1 head is not visible on L2 and the Sync block's
    /// timestamp equals the pinned L1 slot time, so age is derived from timestamps
    /// alone (CT-8).
    uint64 internal constant L1_SLOT_SECONDS = 12;

    /// @notice The snapshot carries no price, so nothing can be quoted from it.
    error UninitialisedMirror();

    /// @notice The snapshot has no in-range liquidity, so the curve is undefined.
    error NoLiquidity();

    /// @notice The spot price implied by the snapshot: B per A in Q96.
    /// @dev `(sqrtPriceX96 / 2**96)**2` carried in Q96, via `mulDiv` so the square
    /// never overflows. This is the clearing price the window nets at (FL-4).
    function spotPriceX96(PoolState memory state) internal pure returns (uint256 priceX96) {
        if (state.sqrtPriceX96 == 0) revert UninitialisedMirror();
        priceX96 = Math.mulDiv(uint256(state.sqrtPriceX96), uint256(state.sqrtPriceX96), Q96);
    }

    /// @notice Value `amount` of the `side`'s sell asset in the buy asset at `priceX96`.
    /// @dev Prices are B per A in Q96 regardless of `Side`, so the direction of the
    /// division is the only thing `side` selects. Rounds **down** (CT-12).
    function valueIn(uint256 amount, uint256 priceX96, Side side) internal pure returns (uint256 outAmount) {
        if (priceX96 == 0) revert UninitialisedMirror();
        outAmount = side == Side.SELL_A_FOR_B ? Math.mulDiv(amount, priceX96, Q96) : Math.mulDiv(amount, Q96, priceX96);
    }

    /// @notice Expected output for `sellAmount` on `side` against `state` (CT-8).
    /// @dev Prices are B per A in Q96 regardless of `Side`; all price arithmetic via
    /// `mulDiv`; outputs round down (CT-2, CT-12). Unlike `valueIn` this walks the
    /// curve, so it carries the impact a swap of this size would have.
    function quote(PoolState memory state, uint256 sellAmount, Side side) internal pure returns (uint256 amountOut) {
        (, amountOut) = advance(state, sellAmount, side);
    }

    /// @notice The same swap as `quote`, plus the state it leaves behind.
    /// @dev This is the simulator half of the mirror: the settler runs it against the L1
    /// head to derive the clearing price and select the fillable subset (SV-2), and it
    /// is why `quote` cannot drift from what a settlement actually does. `post.tick` is
    /// carried through unchanged — nothing in the DEX prices from the tick, and the real
    /// one comes back in `WindowResult` (CT-2).
    function advance(
        PoolState memory state,
        uint256 sellAmount,
        Side side
    )
        internal
        pure
        returns (PoolState memory post, uint256 amountOut)
    {
        if (state.sqrtPriceX96 == 0) revert UninitialisedMirror();
        // A copy, field by field: `post = state` would alias the caller's snapshot and
        // this function would move the mirror it was only asked to read.
        post = PoolState({sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, tick: state.tick});
        if (sellAmount == 0) return (post, 0);
        uint128 liquidity = state.liquidity;
        if (liquidity == 0) revert NoLiquidity();

        uint160 sqrtP = state.sqrtPriceX96;
        if (side == Side.SELL_A_FOR_B) {
            // A (token0) in: the price falls to L*sqrtP / (L + amountIn*sqrtP/Q96).
            uint160 sqrtNext = _nextPriceAIn(sqrtP, liquidity, sellAmount);
            // token1 out between two prices: L * (sqrtP - sqrtNext) / Q96.
            amountOut = Math.mulDiv(uint256(liquidity), uint256(sqrtP) - uint256(sqrtNext), Q96);
            post.sqrtPriceX96 = sqrtNext;
        } else {
            // B (token1) in: the price rises by amountIn * Q96 / L.
            uint256 sqrtNext = uint256(sqrtP) + Math.mulDiv(sellAmount, Q96, liquidity);
            // token0 out between two prices: L * Q96 * (sqrtNext - sqrtP) / (sqrtNext * sqrtP).
            amountOut = Math.mulDiv(uint256(liquidity) << 96, sqrtNext - uint256(sqrtP), sqrtNext) / uint256(sqrtP);
            // casting to 'uint160' is safe because a price that leaves the uint160
            // domain is one no pool can reach; the L1 leg's band rejects it first
            // forge-lint: disable-next-line(unsafe-typecast)
            post.sqrtPriceX96 = uint160(sqrtNext);
        }
    }

    /// @notice The mirror's age in slots: `(timestamp - mirrorTimestamp) / 12`.
    /// @dev The L1 head is not visible on L2, and the Sync block's timestamp equals the
    /// pinned L1 slot time (CT-8). A mirror stamped in the future ages to zero rather
    /// than underflowing.
    function ageSlots(uint64 timestamp, uint64 mirrorTimestamp) internal pure returns (uint32 slots) {
        if (mirrorTimestamp == 0 || timestamp <= mirrorTimestamp) return 0;
        uint64 age = (timestamp - mirrorTimestamp) / L1_SLOT_SECONDS;
        // casting to 'uint32' is safe because the branch saturates at uint32 max first
        // forge-lint: disable-next-line(unsafe-typecast)
        slots = age > type(uint32).max ? type(uint32).max : uint32(age);
    }

    /// @dev `sqrtP' = L * sqrtP / (L + amountIn * sqrtP / Q96)`, rounded up so the
    /// output that follows rounds down. The first branch is exact; the second is the
    /// overflow-safe form a real pool falls back to.
    function _nextPriceAIn(uint160 sqrtP, uint128 liquidity, uint256 amountIn) private pure returns (uint160) {
        uint256 numerator = uint256(liquidity) << 96;
        uint256 product = amountIn * sqrtP;
        if (product / amountIn == sqrtP && numerator + product >= numerator) {
            return uint160(Math.mulDiv(numerator, sqrtP, numerator + product, Math.Rounding.Ceil));
        }
        return uint160(Math.ceilDiv(numerator, (numerator / sqrtP) + amountIn));
    }
}
