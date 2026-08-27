// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title eez-dex shared types — RD-2 appendix A.1, transcribed verbatim.
/// @notice FROZEN AT THE SCAFFOLD. WP-1, WP-2, WP-B and WP-3 all compile
/// against this file; a change to a field name or width is a rewrite for every
/// one of them. Where this file and RD-2 A.1 disagree, A.1 wins.
///
/// Normative, and true of every price in this repository:
/// **Prices are B per A in Q96 regardless of `Side`; all price arithmetic via
/// `mulDiv`.** Per-order outputs round down and the dust accrues to the
/// protocol fee bucket (CT-12).

enum Side {
    SELL_A_FOR_B,
    SELL_B_FOR_A
}

struct Order {
    bytes32 id;
    address owner;
    Side side;
    uint256 sellAmount;
    uint256 minBuyAmount; // the limit; never filled below this
    address recipient; // L2 address (full) or L1 address (genesis)
    uint32 expiresAfter; // windows
}

// Built on L2 by WindowBook.settleWindow from the still-open selected orders;
// the settler never constructs it.
struct WindowLeg {
    uint64 windowId;
    Side residualSide;
    uint256 residualIn; // net amount to swap on L1 after crossing
    uint256 minPriceX96; // price band, B per A, Q96: tightest sell-side limit
    uint256 maxPriceX96; //   and tightest buy-side limit among selected orders
    uint64 deadline; // unix timestamp, checked on L1 (block.timestamp); no L1 head on L2
    bytes distribution; // [genesis] abi-encoded (recipient, sellAmount)[]
}

struct PoolState {
    uint160 sqrtPriceX96;
    uint128 liquidity;
    int24 tick;
}

struct WindowResult {
    uint256 amountIn;
    uint256 amountOut;
    uint256 referencePriceX96; // P0: pre-trade spot read in-leg; every crossed fill clears here
    uint256 executionPriceX96; // realised average for the residual; impact = P0 - this, residual side pays
    PoolState post; // becomes the next mirror
    uint64 l1Block;
}
