/**
 * The fold from the IX-2 stream to what the app knows — RD-2 FE-11, A.4.
 *
 * This is the single reducer the whole app is built on. Live, replay and demo
 * push the same {@link SlotEvent} sequence at it, so there is one data path
 * and no mode-shaped bug can live on one of three (FE-11, FE-10). It is pure
 * and total: folding the same events produces the same state, which is what
 * lets FE-10's scrubber seek by re-folding a prefix, and what makes every
 * transition in A.4 testable without a browser (TS-5).
 *
 * It also **records** transitions rather than only applying them. The state
 * machines in `schema/` are frozen and shared; a transition they do not allow
 * is a defect in whichever phase emitted it, and the theater surfaces it as
 * one (FE-7) instead of quietly rendering it as though it were ordinary.
 */

import type {
  MirrorSnapshot,
  Order,
  OrderState,
  Settlement,
  SlotEvent,
  Window,
  WindowState,
} from "@eez-dex/indexer/schema";
import { ORDER_TRANSITIONS, WINDOW_TRANSITIONS, canTransition } from "@eez-dex/indexer/schema";

/** How many mirror snapshots the inspector keeps (FE-8's refresh history). */
export const MIRROR_HISTORY_LIMIT = 32;

/** How many transitions the theater keeps to draw from (FE-7). */
export const TRANSITION_LIMIT = 256;

/** One move of an order or a window, as the stream reported it. */
export interface Transition {
  readonly seq: number;
  readonly atUnix: number;
  readonly subject: "order" | "window";
  readonly id: string;
  /** The window it happened in — an order's own, a window's id. */
  readonly windowId: string;
  readonly from: OrderState | WindowState;
  readonly to: OrderState | WindowState;
  /**
   * False when A.4 does not allow `from -> to`. The frozen table is the
   * arbiter; this app does not invent a state, and it does not hide one it was
   * sent that the machine forbids.
   */
  readonly legal: boolean;
}

/** The last L1 slot tick, which the theater's progress bar is anchored on. */
export interface SlotMark {
  readonly l1Block: number;
  readonly windowId: string;
  readonly atUnix: number;
}

/** The last L2 block, the 2 s tick six of which make a one-slot window. */
export interface BlockMark {
  readonly l2Block: number;
  readonly windowId: string;
  readonly blocksRemaining: number;
  readonly atUnix: number;
}

/** Everything the fold remembers about the chain. */
export interface ChainState {
  readonly windows: ReadonlyMap<string, Window>;
  /** Window ids in the order they were first observed. */
  readonly windowIds: readonly string[];
  readonly orders: ReadonlyMap<string, Order>;
  /** Order ids in placement order, which is the order they arrived in. */
  readonly orderIds: readonly string[];
  readonly settlements: ReadonlyMap<string, Settlement>;
  readonly settlementIds: readonly string[];
  readonly mirror: MirrorSnapshot | null;
  /** Newest first, capped — FE-8's refresh history. */
  readonly mirrorHistory: readonly MirrorSnapshot[];
  /** The A.5 metrics under their frozen names, or null if none has arrived. */
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly l1Block: number | null;
  readonly l2Block: number | null;
  readonly blocksRemaining: number | null;
  readonly openWindowId: string | null;
  readonly slot: SlotMark | null;
  readonly block: BlockMark | null;
  /** Newest last, capped. */
  readonly transitions: readonly Transition[];
  /** The highest sequence number folded, and the last event's timestamp. */
  readonly seq: number;
  readonly atUnix: number;
  /** Events folded so far. Zero is the honest state before block one. */
  readonly events: number;
}

/** A chain nothing has been observed of yet. */
export function emptyChain(): ChainState {
  return {
    windows: new Map(),
    windowIds: [],
    orders: new Map(),
    orderIds: [],
    settlements: new Map(),
    settlementIds: [],
    mirror: null,
    mirrorHistory: [],
    metrics: null,
    l1Block: null,
    l2Block: null,
    blocksRemaining: null,
    openWindowId: null,
    slot: null,
    block: null,
    transitions: [],
    seq: 0,
    atUnix: 0,
    events: 0,
  };
}

function put<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function append(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

function record(transitions: readonly Transition[], entry: Transition | null): readonly Transition[] {
  if (entry === null) return transitions;
  const next = [...transitions, entry];
  return next.length > TRANSITION_LIMIT ? next.slice(next.length - TRANSITION_LIMIT) : next;
}

/** Folds one event into the chain state. Pure; an unknown event is a no-op. */
export function foldChain(state: ChainState, event: SlotEvent): ChainState {
  const base: ChainState = { ...state, seq: event.seq, atUnix: event.atUnix, events: state.events + 1 };

  switch (event.kind) {
    case "slot":
      return {
        ...base,
        l1Block: event.l1Block,
        openWindowId: event.windowId,
        slot: { l1Block: event.l1Block, windowId: event.windowId, atUnix: event.atUnix },
      };

    case "l2_block":
      return {
        ...base,
        l2Block: event.l2Block,
        blocksRemaining: event.blocksRemaining,
        openWindowId: event.windowId,
        block: {
          l2Block: event.l2Block,
          windowId: event.windowId,
          blocksRemaining: event.blocksRemaining,
          atUnix: event.atUnix,
        },
      };

    case "window": {
      const window = event.window;
      const previous = state.windows.get(window.windowId);
      const transition: Transition | null =
        previous === undefined || previous.state === window.state
          ? null
          : {
              seq: event.seq,
              atUnix: event.atUnix,
              subject: "window",
              id: window.windowId,
              windowId: window.windowId,
              from: previous.state,
              to: window.state,
              legal: canTransition(WINDOW_TRANSITIONS, previous.state, window.state),
            };
      return {
        ...base,
        windows: put(base.windows, window.windowId, window),
        windowIds: append(base.windowIds, window.windowId),
        // A window that reports itself open is the open one; one that leaves
        // `open` stops being it until the next window says otherwise.
        openWindowId:
          window.state === "open"
            ? window.windowId
            : base.openWindowId === window.windowId
              ? null
              : base.openWindowId,
        transitions: record(base.transitions, transition),
      };
    }

    case "order": {
      const order = event.order;
      const previous = state.orders.get(order.id);
      const transition: Transition | null =
        previous === undefined || previous.state === order.state
          ? null
          : {
              seq: event.seq,
              atUnix: event.atUnix,
              subject: "order",
              id: order.id,
              windowId: order.windowId,
              from: previous.state,
              to: order.state,
              legal: canTransition(ORDER_TRANSITIONS, previous.state, order.state),
            };
      return {
        ...base,
        orders: put(base.orders, order.id, order),
        orderIds: append(base.orderIds, order.id),
        transitions: record(base.transitions, transition),
      };
    }

    case "settlement":
      return {
        ...base,
        settlements: put(base.settlements, event.settlement.id, event.settlement),
        settlementIds: append(base.settlementIds, event.settlement.id),
      };

    case "mirror": {
      const history = [event.mirror, ...base.mirrorHistory].slice(0, MIRROR_HISTORY_LIMIT);
      return { ...base, mirror: event.mirror, mirrorHistory: history };
    }

    case "metrics":
      return { ...base, metrics: event.metrics };

    default:
      return state;
  }
}

/** Folds a whole sequence — the scrubber's seek, and the tests' input (FE-10). */
export function foldAll(events: readonly SlotEvent[], from: ChainState = emptyChain()): ChainState {
  return events.reduce(foldChain, from);
}

/**
 * Seeds the chain from the gateway's REST snapshot.
 *
 * A client that connects at event four thousand starts level with one that has
 * been connected since event one (IX-1). The snapshot carries state, not
 * history, so no transitions are recorded from it: nothing was observed to
 * move, and a transition this app did not see is not one it will draw.
 */
export function seedChain(seed: {
  readonly windows: readonly Window[];
  readonly orders: readonly Order[];
  readonly settlements: readonly Settlement[];
  readonly mirror: MirrorSnapshot | null;
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly l1Block: number | null;
  readonly l2Block: number | null;
  readonly blocksRemaining: number | null;
  readonly openWindowId: string | null;
  readonly seq: number;
  readonly atUnix: number;
}): ChainState {
  const windows = new Map(seed.windows.map((window) => [window.windowId, window]));
  const orders = new Map(seed.orders.map((order) => [order.id, order]));
  const settlements = new Map(seed.settlements.map((settlement) => [settlement.id, settlement]));
  return {
    ...emptyChain(),
    windows,
    windowIds: [...windows.keys()],
    orders,
    orderIds: [...orders.keys()],
    settlements,
    settlementIds: [...settlements.keys()],
    mirror: seed.mirror,
    mirrorHistory: seed.mirror === null ? [] : [seed.mirror],
    metrics: seed.metrics,
    l1Block: seed.l1Block,
    l2Block: seed.l2Block,
    blocksRemaining: seed.blocksRemaining,
    openWindowId: seed.openWindowId,
    seq: seed.seq,
    atUnix: seed.atUnix,
    events: 0,
  };
}
