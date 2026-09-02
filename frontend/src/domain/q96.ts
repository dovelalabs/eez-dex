/**
 * Q96 arithmetic, matching the chain's — RD-2 A.1, CT-2, CT-12.
 *
 * **Prices are B per A in Q96 regardless of `Side`** (A.1). Every figure here
 * is derived the way `Mirror`/`WindowBook` derive it, in `bigint`, rounding
 * **down**, because a price the UI prints has to be the price the chain
 * computed — FE-2 forbids showing a fill price that is anything else.
 */

import type { PoolState, Side } from "@eez-dex/indexer/schema";

/** 2^96 — the fixed point every price in this repository is stated in. */
export const Q96 = 1n << 96n;

/** `Math.mulDiv`, rounding down, in arbitrary precision. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("mulDiv by zero");
  return (a * b) / denominator;
}

/** `Mirror.spotPriceX96`: B per A from the pool's sqrt price. */
export function spotPriceX96(state: PoolState): bigint {
  const sqrt = BigInt(state.sqrtPriceX96);
  return mulDiv(sqrt, sqrt, Q96);
}

/** The buy asset of a side, as the pair's two symbols. */
export function buyAssetOf<T>(side: Side, a: T, b: T): T {
  return side === "SELL_A_FOR_B" ? b : a;
}

/** The sell asset of a side. */
export function sellAssetOf<T>(side: Side, a: T, b: T): T {
  return side === "SELL_A_FOR_B" ? a : b;
}

/**
 * The gap between two prices in basis points, signed, `(price - against)`.
 *
 * Drift is the mirror against the L1 head (FE-7) and it is a display figure:
 * the sign says which way the head moved, the magnitude says how far.
 */
export function differenceBps(price: bigint, against: bigint): number | null {
  if (against === 0n) return null;
  return Number(((price - against) * 10_000n * 1000n) / against) / 1000;
}
