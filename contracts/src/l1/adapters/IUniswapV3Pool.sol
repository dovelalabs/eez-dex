// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title The Uniswap v3 pool surface the adapter uses — nothing more.
/// @notice A venue assumption, and so it lives beside the adapter that makes
/// it (CT-3). `MockPool` (HX-1) implements exactly this shape, which is what
/// lets one adapter run unchanged against the mock and against mainnet.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

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
