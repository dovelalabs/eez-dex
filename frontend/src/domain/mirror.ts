/**
 * The mirror's curve, in TypeScript — RD-2 FL-1, FL-2, CT-8, FE-1.
 *
 * `contracts/src/l2/Mirror.sol` is the article; this is the same arithmetic on
 * the reading side, so the swap panel can quote at L2 block cadence without a
 * round trip and still print the number `WindowBook.quote` would return. Every
 * operation rounds the way the Solidity does — `mulDiv` truncating, the price
 * step rounded **up** so the output that follows rounds **down** (CT-2, CT-12).
 *
 * What it produces is **indicative** and the UI says so: the binding price is
 * always the one the L1 leg returns (FL-5, CT-2), and the mirror's age is
 * stated beside every quote rather than left as a footnote (FL-2, FE-1).
 */

import type { PoolState, Side } from "@eez-dex/indexer/schema";

import { Q96, mulDiv } from "./q96.ts";

/** One L1 slot, in seconds — the unit the mirror's age is measured in (CT-8). */
export const L1_SLOT_SECONDS = 12;

/** L2 blocks in one L1 slot. */
export const L2_BLOCKS_PER_SLOT = 6;

/** The L2 block time, in seconds. */
export const L2_BLOCK_SECONDS = 2;

/** A quote against a mirror that carries no price cannot be made. */
export class UninitialisedMirror extends Error {}

/** A quote against a mirror with no in-range liquidity cannot be made. */
export class NoLiquidity extends Error {}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** `Mirror._nextPriceAIn`: where the curve lands after `amountIn` of A. */
function nextPriceAIn(sqrtP: bigint, liquidity: bigint, amountIn: bigint): bigint {
  const numerator = liquidity << 96n;
  // Rounded up so the output that follows rounds down. The Solidity's second
  // branch guards a `uint256` overflow that `bigint` cannot have.
  return ceilDiv(numerator * sqrtP, numerator + amountIn * sqrtP);
}

/** What advancing the mirror by one swap leaves behind. */
export interface Advance {
  readonly post: PoolState;
  readonly amountOut: bigint;
}

/** `Mirror.advance`: the swap, and the state it leaves behind. */
export function advance(state: PoolState, sellAmount: bigint, side: Side): Advance {
  const sqrtP = BigInt(state.sqrtPriceX96);
  if (sqrtP === 0n) throw new UninitialisedMirror("the mirror carries no price");
  if (sellAmount === 0n) return { post: state, amountOut: 0n };

  const liquidity = BigInt(state.liquidity);
  if (liquidity === 0n) throw new NoLiquidity("the mirror has no in-range liquidity");

  if (side === "SELL_A_FOR_B") {
    // A (token0) in: the price falls, and token1 out is L * (sqrtP - next) / Q96.
    const sqrtNext = nextPriceAIn(sqrtP, liquidity, sellAmount);
    return {
      post: { ...state, sqrtPriceX96: sqrtNext.toString() },
      amountOut: mulDiv(liquidity, sqrtP - sqrtNext, Q96),
    };
  }

  // B (token1) in: the price rises by amountIn * Q96 / L, and token0 out is
  // L * Q96 * (next - sqrtP) / (next * sqrtP).
  const sqrtNext = sqrtP + mulDiv(sellAmount, Q96, liquidity);
  return {
    post: { ...state, sqrtPriceX96: sqrtNext.toString() },
    amountOut: mulDiv(liquidity << 96n, sqrtNext - sqrtP, sqrtNext) / sqrtP,
  };
}

/** `Mirror.quote`: the expected output for `sellAmount` on `side`. */
export function quote(state: PoolState, sellAmount: bigint, side: Side): bigint {
  return advance(state, sellAmount, side).amountOut;
}

/** `Mirror.valueIn`: `amount` valued at `priceX96`, without walking the curve. */
export function valueIn(amount: bigint, priceX96: bigint, side: Side): bigint {
  if (priceX96 === 0n) throw new UninitialisedMirror("the mirror carries no price");
  return side === "SELL_A_FOR_B" ? mulDiv(amount, priceX96, Q96) : mulDiv(amount, Q96, priceX96);
}

/**
 * `Mirror.ageSlots`: `(timestamp - mirrorTimestamp) / 12`.
 *
 * The L1 head is not visible from L2, so this is the only age there is (CT-8).
 * A mirror stamped in the future ages to zero rather than going negative.
 */
export function ageSlots(timestamp: number, mirrorTimestamp: number): number {
  if (mirrorTimestamp === 0 || timestamp <= mirrorTimestamp) return 0;
  return Math.floor((timestamp - mirrorTimestamp) / L1_SLOT_SECONDS);
}
