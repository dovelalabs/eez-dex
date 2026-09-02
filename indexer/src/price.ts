/**
 * Q96 price arithmetic, matching the chain's — RD-2 A.1, CT-2, CT-12.
 *
 * **Prices are B per A in Q96 regardless of `Side`.** Every figure here is
 * derived the way `Mirror`/`WindowBook` derive it, in `bigint`, rounding
 * **down**, so a number the gateway prints is the number the chain computed
 * and never a re-derivation that drifts by a wei.
 */

import type { PoolState, PriceX96, Side } from "../schema/index.ts";

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

/**
 * `WindowBook`'s notional: one order's sell amount in **A units** at `price`.
 *
 * The book values a B-side order as `sellAmount * Q96 / price` when it sums a
 * window's gross (CT-9), and the window's `nettingRatio` is only comparable if
 * the gateway sums it the same way.
 */
export function notionalInA(sellAmount: bigint, side: Side, priceX96: bigint): bigint {
  if (priceX96 === 0n) return 0n;
  return side === "SELL_A_FOR_B" ? sellAmount : mulDiv(sellAmount, Q96, priceX96);
}

/**
 * The price one fill actually cleared at, from the amounts the chain emitted.
 *
 * `netIn` is the order's input after CT-12's deductions —
 * `sellAmount - feeAmount - routeFeeAmount` — and the fill's price is that
 * input against its output, B per A either way. For a crossed order this is
 * the window's reference price; for a residual-side order it is that price
 * less its impact share, which is exactly what FL-5 promises and what the
 * book's `_impact` inverts.
 */
export function fillPriceX96(netIn: bigint, amountOut: bigint, side: Side): PriceX96 {
  if (netIn === 0n || amountOut === 0n) return "0";
  const price =
    side === "SELL_A_FOR_B" ? mulDiv(amountOut, Q96, netIn) : mulDiv(netIn, Q96, amountOut);
  return price.toString();
}

/**
 * Which way the residual traded, read off the L1 leg's own numbers.
 *
 * `SettlementRouter` computes the execution price as `out/in` when the residual
 * sold A and `in/out` when it sold B, both B per A, and a swap always moves the
 * price against the side that made it. So an execution price below `P0` is a
 * residual that sold A and one above it is a residual that sold B. When the two
 * are equal there was no impact to bear and the question does not change a
 * number, so this returns null rather than guessing (CT-6's refresh is that
 * case exactly).
 *
 * The settler's own projection is preferred wherever it is available; this is
 * what the gateway falls back to when it is reading the chain alone.
 */
export function residualSideFromResult(
  referencePriceX96: bigint,
  executionPriceX96: bigint,
): Side | null {
  if (executionPriceX96 === referencePriceX96) return null;
  return executionPriceX96 < referencePriceX96 ? "SELL_A_FOR_B" : "SELL_B_FOR_A";
}

/** `1 - |residual| / gross`, the number that carries the economics (A.5). */
export function nettingRatio(grossInA: bigint, residualInA: bigint): number | null {
  if (grossInA <= 0n) return null;
  const ratio = 1 - Number(residualInA) / Number(grossInA);
  return ratio < 0 ? 0 : ratio;
}
