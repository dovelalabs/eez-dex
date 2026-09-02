/**
 * The arithmetic the contracts do, redone here — RD-2 A.1, CT-2, CT-12.
 *
 * The scenario is an *independent* check on a settlement, so it recomputes
 * every fill from the window's inputs rather than trusting the numbers the
 * chain emitted. That only works if it rounds exactly as Solidity does:
 * `mulDiv` truncating, `Math.Rounding.Ceil` where `_priceBand` uses it, and
 * `Q96` fixed point throughout. `bigint` is the only correct type here — a
 * double loses a wei somewhere above 2^53 and the escrow invariant is asserted
 * to the wei.
 *
 * Prices are B per A in Q96 regardless of `Side` (A.1). Every helper below
 * follows that convention and none of them takes a `Side` to mean otherwise.
 */

/** `2**96`, the fixed-point scale of every price in this repository. */
export const Q96 = 1n << 96n;

/** Basis points denominator, as `WindowBook` uses it. */
export const BPS_DENOMINATOR = 10_000n;

/** OpenZeppelin `Math.mulDiv`: `a * b / d`, truncating. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDiv: division by zero");
  return (a * b) / d;
}

/** OpenZeppelin `Math.mulDiv(..., Math.Rounding.Ceil)`. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDivCeil: division by zero");
  const product = a * b;
  const quotient = product / d;
  return product % d === 0n ? quotient : quotient + 1n;
}

/** `|a - b|`. */
export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/**
 * The spot price of a pool state, B per A in Q96 — `Mirror.spotPriceX96`.
 *
 * A Uniswap-v3-shaped `sqrtPriceX96` is `sqrt(token1/token0) * 2**96`, and A is
 * the pool's `token0` in this pair family, so the price is the square of it
 * scaled back down once.
 */
export function spotPriceX96(sqrtPriceX96: bigint): bigint {
  return mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
}

/**
 * What `sellAmount` of A buys in B at `priceX96`, rounding down (CT-12).
 */
export function quoteAForB(amountA: bigint, priceX96: bigint): bigint {
  return mulDiv(amountA, priceX96, Q96);
}

/**
 * What `sellAmount` of B buys in A at `priceX96`, rounding down (CT-12).
 */
export function quoteBForA(amountB: bigint, priceX96: bigint): bigint {
  return mulDiv(amountB, Q96, priceX96);
}

/**
 * The price one fill realised, B per A in Q96.
 *
 * The direction matters for the arithmetic but not for the convention: an
 * A-side fill pays `netIn` of A for `amountOut` of B, a B-side fill pays
 * `netIn` of B for `amountOut` of A, and both are quoted B per A.
 */
export function realisedPriceX96(netIn: bigint, amountOut: bigint, sideIsA: boolean): bigint {
  if (sideIsA) {
    if (netIn === 0n) return 0n;
    return mulDiv(amountOut, Q96, netIn);
  }
  if (amountOut === 0n) return 0n;
  return mulDiv(netIn, Q96, amountOut);
}

/**
 * `WindowBook._impact`: what a residual-side order paid for causing the swap,
 * in **sell-asset units** (CT-12). A fill better than `P0` reports zero rather
 * than a negative cost.
 */
export function impactAmount(netIn: bigint, amountOut: bigint, p0X96: bigint, sideIsA: boolean): bigint {
  const inputAtP0 = sideIsA ? mulDiv(amountOut, Q96, p0X96) : mulDiv(amountOut, p0X96, Q96);
  return netIn > inputAtP0 ? netIn - inputAtP0 : 0n;
}

/**
 * The A.5 `impact_bps` of a settlement: how far the residual's realised
 * average fell from `P0`, in basis points.
 *
 * The residual side always pays, so the figure is reported unsigned — a
 * negative would mean the swap moved the price in the residual's favour, which
 * `_impact` already floors at zero per order.
 */
export function impactBps(referencePriceX96: bigint, executionPriceX96: bigint): number {
  if (referencePriceX96 === 0n) return 0;
  const drop = absDiff(referencePriceX96, executionPriceX96);
  return Number((drop * BPS_DENOMINATOR * 1000n) / referencePriceX96) / 1000;
}

/**
 * `1 - |residual| / gross` — A.5's `netting_ratio`, the number that carries the
 * economics. Gross of zero nets nothing rather than dividing by zero.
 */
export function nettingRatio(grossIn: bigint, residualIn: bigint): number {
  if (grossIn === 0n) return 0;
  const scaled = (residualIn * 1_000_000n) / grossIn;
  return 1 - Number(scaled) / 1_000_000;
}

/** Parses a decimal string from the wire back into a `bigint`. */
export function toBig(value: string): bigint {
  return BigInt(value);
}

/** Renders a `bigint` as the decimal string the IX-2 schema puts on the wire. */
export function fromBig(value: bigint): string {
  return value.toString(10);
}
