/**
 * The stream envelope — RD-2 IX-1, IX-2, FE-11, FE-12.
 *
 * FROZEN AT THE SCAFFOLD.
 *
 * One ordered sequence carries everything: clock ticks, L2 blocks, and every
 * change to a window, an order, a settlement or the mirror. The frontend is a
 * single reducer over this sequence, which is what makes replay, live and demo
 * one code path (FE-11) — and why the clock is an event rather than a timer
 * the browser runs on its own. A stalled chain must be a visibly stalled
 * window, not an animation that keeps going (FE-12).
 */

import type { UnixSeconds } from "./common.ts";
import type { MirrorSnapshot } from "./mirror.ts";
import type { Order } from "./order.ts";
import type { Settlement } from "./settlement.ts";
import type { Versioned } from "./version.ts";
import type { Window } from "./window.ts";

/** The kinds of event the stream carries. */
export const SLOT_EVENT_KINDS = ["slot", "l2_block", "window", "order", "settlement", "mirror", "metrics"] as const;

/** Which kind an event is. */
export type SlotEventKind = (typeof SLOT_EVENT_KINDS)[number];

/** What every event carries. */
export interface SlotEventBase extends Versioned {
  /**
   * Monotonic from the start of the stream. A replay of a recorded run
   * reproduces the same sequence, which is the whole of "replay equals live"
   * (IX-1, TS-5).
   */
  readonly seq: number;
  readonly kind: SlotEventKind;
  readonly atUnix: UnixSeconds;
}

/** An L1 slot boundary — the 12 s clock the theater's progress bar runs on. */
export interface SlotTickEvent extends SlotEventBase {
  readonly kind: "slot";
  readonly l1Block: number;
  /** The window this slot belongs to. */
  readonly windowId: string;
}

/** An L2 block — the 2 s tick, six to a one-slot window. */
export interface L2BlockEvent extends SlotEventBase {
  readonly kind: "l2_block";
  readonly l2Block: number;
  readonly windowId: string;
  /** L2 blocks left before the Sync block. */
  readonly blocksRemaining: number;
}

/** A window was opened, or moved state. */
export interface WindowEvent extends SlotEventBase {
  readonly kind: "window";
  readonly window: Window;
}

/** An order was placed, selected, filled, rolled, cancelled or expired. */
export interface OrderEvent extends SlotEventBase {
  readonly kind: "order";
  readonly order: Order;
}

/** A settlement was submitted, or its outcome became known. */
export interface SettlementEvent extends SlotEventBase {
  readonly kind: "settlement";
  readonly settlement: Settlement;
}

/** The mirror was refreshed. */
export interface MirrorEvent extends SlotEventBase {
  readonly kind: "mirror";
  readonly mirror: MirrorSnapshot;
}

/**
 * The settler's metrics, by the A.5 names. Frozen in
 * `settler/src/config.rs`; `METRIC_NAMES` here is the same list and the
 * indexer's schema test asserts the two have not drifted.
 */
export interface MetricsEvent extends SlotEventBase {
  readonly kind: "metrics";
  readonly metrics: Readonly<Record<string, number>>;
}

/** Everything the IX-1 stream can deliver. */
export type SlotEvent =
  | SlotTickEvent
  | L2BlockEvent
  | WindowEvent
  | OrderEvent
  | SettlementEvent
  | MirrorEvent
  | MetricsEvent;
