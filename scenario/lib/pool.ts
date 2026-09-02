/**
 * `MockPool`'s curve, in TypeScript — RD-2 HX-1.
 *
 * `contracts/test/mocks/MockPool.sol` is frozen: the scenario packages and
 * deploys it, it does not fork it. What lives here is the same arithmetic on
 * the reading side, so the harness can say what a swap *should* have returned
 * before it looks at what it did. Without an independent computation, "the
 * residual settled correctly" is only the chain agreeing with itself.
 *
 * Every operation rounds the way the Solidity does — `Math.mulDiv` truncating,
 * `Math.Rounding.Ceil` where the pool consumes input, `ceilDiv` in the price
 * step — because a wei of drift here is a false failure there.
 */

import { Q96, mulDiv, mulDivCeil } from "./math.ts";
import type { PoolState } from "../../indexer/schema/index.ts";
import { fromBig, toBig } from "./math.ts";

/** The v3 price domain. */
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** A pool as the simulator holds it. */
export interface Pool {
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  /** The pool's fee in hundredths of a bip, as Uniswap quotes it (3000 = 0.3%). */
  readonly fee: bigint;
}

/** What one swap did. */
export interface SwapResult {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly pool: Pool;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** `Math.log2` on a `uint256`: the index of the most significant set bit. */
function log2(value: bigint): bigint {
  if (value <= 0n) throw new Error("log2: input must be positive");
  return BigInt(value.toString(2).length - 1);
}

/** `_nextPrice`: where the curve lands after `amountIn` of the input token. */
export function nextPrice(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (amountIn === 0n) return sqrtP;
  if (zeroForOne) {
    const numerator = liquidity << 96n;
    const product = amountIn * sqrtP;
    // The Solidity guards an overflow the `uint256` arithmetic could hit;
    // `bigint` cannot, so the guarded branch is the one that always applies.
    if (numerator + product >= numerator) return mulDivCeil(numerator, sqrtP, numerator + product);
    return ceilDiv(numerator, numerator / sqrtP + amountIn);
  }
  return sqrtP + mulDiv(amountIn, Q96, liquidity);
}

/** `_amount0Delta`: token0 between two prices, `L * Q96 * (b - a) / (b * a)`. */
export function amount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  if (roundUp) return ceilDiv(mulDivCeil(numerator1, numerator2, b), a);
  return mulDiv(numerator1, numerator2, b) / a;
}

/** `_amount1Delta`: token1 between two prices, `L * (b - a) / Q96`. */
export function amount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  return roundUp ? mulDivCeil(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

/**
 * `MockPool.swap`, exact input and no price limit — the shape the adapter uses
 * (CT-3: the band check on the realised price is the router's protection, so
 * the swap itself is unbounded and consumes the whole residual).
 */
export function swap(pool: Pool, zeroForOne: boolean, amountIn: bigint): SwapResult {
  if (amountIn <= 0n) throw new Error("swap: exact input only");
  if (pool.liquidity === 0n) throw new Error("swap: the pool has no liquidity");

  const amountInLessFee = mulDiv(amountIn, 1_000_000n - pool.fee, 1_000_000n);
  const sqrtPriceNext = nextPrice(pool.sqrtPriceX96, pool.liquidity, amountInLessFee, zeroForOne);
  const amountOut = zeroForOne
    ? amount1Delta(sqrtPriceNext, pool.sqrtPriceX96, pool.liquidity, false)
    : amount0Delta(pool.sqrtPriceX96, sqrtPriceNext, pool.liquidity, false);

  if (sqrtPriceNext < MIN_SQRT_RATIO || sqrtPriceNext >= MAX_SQRT_RATIO) {
    throw new Error("swap: the price left the v3 domain");
  }

  return { amountIn, amountOut, pool: { ...pool, sqrtPriceX96: sqrtPriceNext } };
}

/**
 * `tickAtSqrtRatio`: `floor(log_1.0001(price))`, carried to 40 fractional bits
 * exactly as the mock does. Nothing in the DEX prices from the tick — quotes
 * and the mirror use `sqrtPriceX96` and `liquidity` — but the mirror carries
 * it, so the harness has to reproduce it to compare states word for word.
 */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error("tickAtSqrtRatio: the price is outside the v3 domain");
  }
  const msb = log2(sqrtPriceX96);
  let log2Q64 = (msb - 96n) << 64n;

  let r = msb >= 127n ? sqrtPriceX96 >> (msb - 127n) : sqrtPriceX96 << (127n - msb);
  for (let i = 0n; i < 40n; i += 1n) {
    r = (r * r) >> 127n;
    const bit = r >> 128n;
    log2Q64 |= bit << (63n - i);
    r >>= bit;
  }

  const tickQ64 = (log2Q64 * 2n * 127869479499815995262605n) >> 64n;
  return Number(tickQ64 >> 64n);
}

/** The pool as the IX-2 schema carries it. */
export function toPoolState(pool: Pool): PoolState {
  return {
    sqrtPriceX96: fromBig(pool.sqrtPriceX96),
    liquidity: fromBig(pool.liquidity),
    tick: tickAtSqrtRatio(pool.sqrtPriceX96),
  };
}

/** The pool as the simulator holds it, from a schema `PoolState`. */
export function fromPoolState(state: PoolState, fee: bigint): Pool {
  return { sqrtPriceX96: toBig(state.sqrtPriceX96), liquidity: toBig(state.liquidity), fee };
}

/**
 * A `sqrtPriceX96` for a price of `b` B per A, to `scale` decimal places.
 *
 * The scenario picks pool prices by the number a human reads — "3000 B per A"
 * — and this is the only place that number becomes a square root, so a drifted
 * price and a genesis price are constructed the same way.
 */
export function sqrtPriceForPrice(numerator: bigint, denominator: bigint): bigint {
  // sqrt(numerator / denominator) * 2**96, by integer Newton on the scaled
  // square: exact enough that squaring it back reproduces the price to the
  // precision Q96 can hold.
  const target = (numerator << 192n) / denominator;
  if (target === 0n) throw new Error("sqrtPriceForPrice: price rounds to zero");
  let guess = 1n << BigInt(Math.ceil((target.toString(2).length + 1) / 2));
  for (;;) {
    const next = (guess + target / guess) >> 1n;
    if (next >= guess) break;
    guess = next;
  }
  return guess;
}
