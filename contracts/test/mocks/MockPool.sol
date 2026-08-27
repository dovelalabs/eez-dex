// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The callback a Uniswap v3 pool makes to collect the swap's input.
/// Named exactly as the real pool names it so one adapter (CT-3) works
/// unchanged against this mock and against mainnet.
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @title A minimal Uniswap-v3-shaped pool — RD-2 HX-1.
/// @notice FROZEN AT THE SCAFFOLD. WP-1 unit-tests its adapter against this and
/// WP-4 packages it into the enclave deployment bundle (UP-1), so it belongs
/// here rather than in either.
///
/// What is real: the swap curve. Liquidity is a single range that spans every
/// price, so `swap` moves `sqrtPriceX96` along the constant-product curve of
/// the virtual reserves exactly as a v3 pool inside one tick does, charges the
/// fee tier on the input, honours `sqrtPriceLimitX96`, and collects the input
/// through the real callback.
///
/// What is a mock: there are no ticks to cross, no oracle, no positions, and
/// no protocol fee. `setSqrtPriceX96` and `setLiquidity` let the harness move
/// the pool under the window (the HX-3 `drift` op) without trading.
///
/// Exact-input only: `amountSpecified` must be positive. The DEX never asks a
/// pool for an exact output — the residual is an amount in (CT-1).
contract MockPool {
    error InvalidAmount();
    error InvalidPriceLimit();
    error InsufficientInput();
    error PriceOutOfRange();

    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    uint256 private constant Q96 = 0x1000000000000000000000000;

    /// @dev The v3 price domain: tick -887272 … 887272.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public immutable token0;
    address public immutable token1;
    /// @notice Fee tier in hundredths of a basis point: 3000 is 0.30%.
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    uint128 public liquidity;

    constructor(address token0_, address token1_, uint24 fee_, uint160 sqrtPriceX96_, uint128 liquidity_) {
        require(token0_ < token1_, "token0 >= token1");
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        _setPrice(sqrtPriceX96_);
        liquidity = liquidity_;
    }

    // --- state reads, v3-shaped ------------------------------------------------

    /// @notice The v3 `slot0` tuple. Only the first two fields are meaningful
    /// here; the observation and protocol-fee fields exist so an adapter
    /// written against the real pool decodes this one.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96_,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, tickAtSqrtRatio(sqrtPriceX96), 0, 1, 1, 0, true);
    }

    // --- harness controls (HX-1, HX-3 `drift`) ---------------------------------

    function setSqrtPriceX96(uint160 sqrtPriceX96_) external {
        _setPrice(sqrtPriceX96_);
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    // --- the swap --------------------------------------------------------------

    /// @notice Swaps along the curve, exact input only.
    /// @param zeroForOne True to sell `token0` for `token1` (price falls).
    /// @param amountSpecified The exact input, fee inclusive. Must be > 0.
    /// @param sqrtPriceLimitX96 The worst price the swap may reach. Input is
    /// consumed only as far as this bound, exactly as a real pool does.
    /// @return amount0 Signed `token0` delta: positive into the pool.
    /// @return amount1 Signed `token1` delta: negative out of the pool.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    )
        external
        returns (int256 amount0, int256 amount1)
    {
        if (amountSpecified <= 0) revert InvalidAmount();
        uint160 sqrtPriceStart = sqrtPriceX96;
        uint128 l = liquidity;
        if (l == 0) revert InvalidAmount();

        if (zeroForOne) {
            if (sqrtPriceLimitX96 >= sqrtPriceStart || sqrtPriceLimitX96 <= MIN_SQRT_RATIO) revert InvalidPriceLimit();
        } else {
            if (sqrtPriceLimitX96 <= sqrtPriceStart || sqrtPriceLimitX96 >= MAX_SQRT_RATIO) revert InvalidPriceLimit();
        }

        // The fee is charged on the input, so the curve only sees the rest.
        // casting to 'uint256' is safe because amountSpecified was checked positive above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountInLessFee = Math.mulDiv(amountIn, 1e6 - fee, 1e6);

        uint160 sqrtPriceNext = _nextPrice(sqrtPriceStart, l, amountInLessFee, zeroForOne);

        uint256 amountOut;
        if ((zeroForOne && sqrtPriceNext < sqrtPriceLimitX96) || (!zeroForOne && sqrtPriceNext > sqrtPriceLimitX96)) {
            // The limit binds: stop there and consume only what it costs.
            sqrtPriceNext = sqrtPriceLimitX96;
            amountInLessFee = zeroForOne
                ? _amount0Delta(sqrtPriceNext, sqrtPriceStart, l, true)
                : _amount1Delta(sqrtPriceStart, sqrtPriceNext, l, true);
            // fee = amountInLessFee * fee / (1e6 - fee), rounded up
            amountIn = amountInLessFee + Math.mulDiv(amountInLessFee, fee, 1e6 - fee, Math.Rounding.Ceil);
        }

        amountOut = zeroForOne
            ? _amount1Delta(sqrtPriceNext, sqrtPriceStart, l, false)
            : _amount0Delta(sqrtPriceStart, sqrtPriceNext, l, false);

        _setPrice(sqrtPriceNext);

        // v3 reports deltas as int256; a pool that could not is not one.
        if (amountIn > uint256(type(int256).max) || amountOut > uint256(type(int256).max)) revert InvalidAmount();
        // forge-lint: disable-start(unsafe-typecast)
        // casting to 'int256' is safe because both amounts were just bounded by int256 max
        amount0 = zeroForOne ? int256(amountIn) : -int256(amountOut);
        amount1 = zeroForOne ? -int256(amountOut) : int256(amountIn);
        // forge-lint: disable-end(unsafe-typecast)

        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;

        if (amountOut > 0) _safeTransfer(tokenOut, recipient, amountOut);

        uint256 balanceBefore = _balanceOf(tokenIn);
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        if (_balanceOf(tokenIn) < balanceBefore + amountIn) revert InsufficientInput();

        emit Swap(msg.sender, recipient, amount0, amount1, sqrtPriceNext, l, tickAtSqrtRatio(sqrtPriceNext));
    }

    // --- curve -----------------------------------------------------------------

    function _nextPrice(uint160 sqrtP, uint128 l, uint256 amountIn, bool zeroForOne) private pure returns (uint160) {
        if (amountIn == 0) return sqrtP;
        if (zeroForOne) {
            // token0 in: sqrtP' = L * sqrtP / (L + amountIn * sqrtP / Q96), rounded up.
            uint256 numerator = uint256(l) << 96;
            uint256 product = amountIn * sqrtP;
            if (product / amountIn == sqrtP && numerator + product >= numerator) {
                return uint160(Math.mulDiv(numerator, sqrtP, numerator + product, Math.Rounding.Ceil));
            }
            return uint160(Math.ceilDiv(numerator, (numerator / sqrtP) + amountIn));
        }
        // token1 in: sqrtP' = sqrtP + amountIn * Q96 / L, rounded down.
        return uint160(sqrtP + Math.mulDiv(amountIn, Q96, l));
    }

    /// @dev token0 between two prices: L * Q96 * (b - a) / (b * a).
    function _amount0Delta(uint160 a, uint160 b, uint128 l, bool roundUp) private pure returns (uint256) {
        uint256 numerator1 = uint256(l) << 96;
        uint256 numerator2 = uint256(b) - uint256(a);
        if (roundUp) {
            return Math.ceilDiv(Math.mulDiv(numerator1, numerator2, b, Math.Rounding.Ceil), a);
        }
        return Math.mulDiv(numerator1, numerator2, b) / a;
    }

    /// @dev token1 between two prices: L * (b - a) / Q96.
    function _amount1Delta(uint160 a, uint160 b, uint128 l, bool roundUp) private pure returns (uint256) {
        return Math.mulDiv(l, uint256(b) - uint256(a), Q96, roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    // --- tick ------------------------------------------------------------------

    /// @notice `floor(log_1.0001(price))` for `price = (sqrtPriceX96 / 2**96)**2`.
    /// @dev A binary logarithm carried to 40 fractional bits, so the result is
    /// within ~1e-8 of a tick. Exactly at a tick boundary it may land one tick
    /// low; nothing in the DEX prices from the tick — quotes and the mirror use
    /// `sqrtPriceX96` and `liquidity` — so it is informational here.
    function tickAtSqrtRatio(uint160 sqrtPriceX96_) public pure returns (int24) {
        if (sqrtPriceX96_ < MIN_SQRT_RATIO || sqrtPriceX96_ >= MAX_SQRT_RATIO) revert PriceOutOfRange();

        uint256 x = uint256(sqrtPriceX96_);
        uint256 msb = Math.log2(x);

        // log2(sqrtPriceX96 / 2**96) as a signed Q64.64: integer part first.
        // casting to 'int256' is safe because Math.log2 of a uint256 is at most 255
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 log2Q64 = (int256(msb) - 96) << 64;

        // Normalise the mantissa to Q127 in [1, 2), then square out the
        // fraction one bit at a time.
        uint256 r = msb >= 127 ? x >> (msb - 127) : x << (127 - msb);
        for (uint256 i = 0; i < 40; ++i) {
            r = (r * r) >> 127; // Q127 in [1, 4)
            uint256 bit = r >> 128; // 1 when the square reached 2
            // casting to 'int256' is safe because bit is 0 or 1 and i < 40
            // forge-lint: disable-next-line(unsafe-typecast)
            log2Q64 |= int256(bit << (63 - i));
            r >>= bit;
        }

        // price = ratio**2, so log2(price) = 2 * log2(ratio); dividing by
        // log2(1.0001) is a multiply by 1/log2(1.0001) in Q64.
        int256 tickQ64 = (log2Q64 * 2 * int256(uint256(127869479499815995262605))) >> 64;
        // casting to 'int24' is safe because the price was bounded to the v3 tick domain above
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(tickQ64 >> 64);
    }

    // --- plumbing --------------------------------------------------------------

    function _setPrice(uint160 sqrtPriceX96_) private {
        if (sqrtPriceX96_ < MIN_SQRT_RATIO || sqrtPriceX96_ >= MAX_SQRT_RATIO) revert PriceOutOfRange();
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok && ret.length >= 32, "balanceOf failed");
        return abi.decode(ret, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}
