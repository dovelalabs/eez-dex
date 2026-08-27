/**
 * The window — RD-2 IX-2, A.4, EC-6.
 *
 * FROZEN AT THE SCAFFOLD.
 */

import type { Side, Transitions, Uint256, UnixSeconds } from "./common.ts";
import type { Hash32 } from "./common.ts";
import type { Versioned } from "./version.ts";

/** A.4: `open -> settling -> settled | evicted | rolled back`. */
export const WINDOW_STATES = ["open", "settling", "settled", "evicted", "rolled_back"] as const;

/** Where a window is. */
export type WindowState = (typeof WINDOW_STATES)[number];

/**
 * A.4's window machine. An evicted or rolled-back window returns to `open`
 * with its orders intact — that return is why both are non-terminal.
 *
 * `settled -> rolled_back` is the case the demo turns on: the bundle landed,
 * the L2 blocks were produced, and then the bundle was missed or reorged, so
 * the blocks un-happen. It is a repair, not an error (FE-7).
 */
export const WINDOW_TRANSITIONS: Transitions<WindowState> = {
  open: ["settling"],
  settling: ["settled", "evicted", "rolled_back"],
  settled: ["rolled_back"],
  evicted: ["open"],
  rolled_back: ["open"],
};

/** How many L1 slots a window spans (EC-6). */
export type WindowSlots = 1 | 2;

/** One window of trading. */
export interface Window extends Versioned {
  /** uint64, as a decimal string. */
  readonly windowId: string;
  readonly state: WindowState;
  /** The EC-6 setting this window was opened under. */
  readonly slots: WindowSlots;
  readonly openedAtL2Block: number;
  readonly openedAtUnix: UnixSeconds;
  /** The L2 block that carried `settleWindow`, once there is one. */
  readonly syncL2Block: number | null;
  /** Every order that belonged to this window, in placement order. */
  readonly orderIds: readonly Hash32[];
  /** The ids the settler selected, ascending — a suggestion, not the fill set. */
  readonly selectedOrderIds: readonly Hash32[];
  /** The settlement that closed it, once there is one. */
  readonly settlementId: Hash32 | null;
  /** Gross volume placed, before crossing, in sell-asset units. */
  readonly grossIn: Uint256;
  /** What actually went to L1 after crossing (FL-4). Zero in a CT-6 refresh. */
  readonly residualIn: Uint256;
  readonly residualSide: Side | null;
  /**
   * `1 - |residual| / gross` — the number that carries the economics (A.5).
   * Null until the window closes; zero in the genesis form, where there is no
   * crossing and the whole window is the residual.
   */
  readonly nettingRatio: number | null;
}
