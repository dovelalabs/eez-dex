/**
 * Primitives shared by every schema type — RD-2 IX-2, appendix A.1.
 *
 * FROZEN AT THE SCAFFOLD. WP-4's fixture (HX-5), WP-5's stream (IX-1) and
 * WP-6's reducer (FE-11) all import these, which is what lets those phases be
 * built apart and still agree.
 *
 * **Numbers on the wire.** Every chain quantity that can exceed 2^53 — an
 * amount, a price, a gas figure, a window id — travels as a decimal string,
 * because JSON has one number type and it is a double. Block heights,
 * timestamps and counts are plain numbers. Ratios computed for display
 * (`nettingRatio`, `rollRate`) are numbers, and lossy by construction.
 */

/** A 0x-prefixed 20-byte address, lower case. */
export type Address = string;

/** A 0x-prefixed 32-byte hash, lower case. */
export type Hash32 = string;

/** An unsigned integer too wide for a double, as a decimal string. */
export type Uint256 = string;

/**
 * A price, B per A, in Q96 — as a decimal string.
 *
 * Prices are B per A regardless of {@link Side}; that convention is normative
 * (A.1) and every price in this schema follows it.
 */
export type PriceX96 = string;

/** Unix seconds. */
export type UnixSeconds = number;

/** A.1's `Side`, by name rather than by ordinal so a log stays readable. */
export const SIDES = ["SELL_A_FOR_B", "SELL_B_FOR_A"] as const;

/** Which way an order or a residual trades. */
export type Side = (typeof SIDES)[number];

/** A.1's `PoolState`: what the mirror is a copy of. */
export interface PoolState {
  /** uint160 */
  readonly sqrtPriceX96: Uint256;
  /** uint128 */
  readonly liquidity: Uint256;
  /** int24 */
  readonly tick: number;
}

/**
 * A state machine as data: for each state, the states it may move to.
 *
 * The tables live here rather than in the reducer because three phases have to
 * agree on them, and because a transition the spec does not name is a bug in
 * whichever phase emitted it, not a case for the frontend to render.
 */
export type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Whether `from -> to` is a transition the state machine allows. */
export function canTransition<S extends string>(table: Transitions<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}
