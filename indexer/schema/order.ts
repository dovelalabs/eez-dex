/**
 * The order — RD-2 IX-2, A.4, CT-7, CT-12.
 *
 * FROZEN AT THE SCAFFOLD.
 */

import type { Address, Hash32, PriceX96, Side, Transitions, Uint256, UnixSeconds } from "./common.ts";
import type { Versioned } from "./version.ts";

/** A.4: `open -> selected -> filled`, or rolled, cancelled, expired. */
export const ORDER_STATES = ["open", "selected", "filled", "rolled", "cancelled", "expired"] as const;

/** Where an order is. */
export type OrderState = (typeof ORDER_STATES)[number];

/**
 * A.4's order machine.
 *
 * `rolled` is not terminal: an order whose limit was not met at the boundary
 * remains open in the next window (FL-8), and that is the honest thing for the
 * UI to say (FE-2). `filled -> open` and `selected -> open` exist for the same
 * reason `settled -> rolled_back` does on the window: a rolled-back bundle
 * undoes fills and the order is open again, intact.
 */
export const ORDER_TRANSITIONS: Transitions<OrderState> = {
  open: ["selected", "rolled", "cancelled", "expired"],
  selected: ["filled", "rolled", "open"],
  filled: ["open"],
  rolled: ["open"],
  cancelled: [],
  expired: [],
};

/**
 * What one fill cost, absolutely, in sell-asset units (CT-12).
 *
 * Every deduction is emitted rather than inferred, so the indexer and the UI
 * cannot disagree with the chain about what a user paid.
 */
export interface OrderFill {
  /** uint64, as a decimal string. */
  readonly windowId: string;
  /** Net output after every deduction below. Never less than `minBuyAmount`. */
  readonly amountOut: Uint256;
  /** The EC-1 protocol fee. */
  readonly feeAmount: Uint256;
  /** This order's share of the window's route fee. Zero while absorbed. */
  readonly routeFeeAmount: Uint256;
  /** This order's pro-rata share of the residual's impact. Zero if crossed. */
  readonly impactAmount: Uint256;
  /**
   * The price this order cleared at: the window's `referencePriceX96` if it
   * crossed, that price less its impact share if it was on the residual side
   * (FL-5).
   */
  readonly priceX96: PriceX96;
  /** True if the order was matched inside the window rather than on L1. */
  readonly crossed: boolean;
  /** The settlement that filled it. */
  readonly settlementId: Hash32;
}

/** A limit order, as placed and as it stands. */
export interface Order extends Versioned {
  /** `keccak256(owner, nonce)`, derived on-chain and never user-supplied. */
  readonly id: Hash32;
  readonly owner: Address;
  readonly side: Side;
  readonly sellAmount: Uint256;
  /** The limit, net of fees and impact. Never filled below this (CT-10). */
  readonly minBuyAmount: Uint256;
  /** An L2 address in the full form, an L1 address in the genesis form. */
  readonly recipient: Address;
  /** Lifetime in windows (uint32). */
  readonly expiresAfter: number;
  readonly state: OrderState;
  readonly placedAtL2Block: number;
  readonly placedAtUnix: UnixSeconds;
  /** The window the order currently belongs to; it moves on when it rolls. */
  readonly windowId: string;
  /** How many windows it has already rolled through (FE-7, `roll_rate`). */
  readonly rolledCount: number;
  readonly fill: OrderFill | null;
}
