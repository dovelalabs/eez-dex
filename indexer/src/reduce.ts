/**
 * The snapshot, folded from the stream — RD-2 IX-1, IX-3, FE-11.
 *
 * The REST snapshot is not a second view of the world: it is the reduction of
 * the same {@link SlotEvent} sequence the WebSocket carries, by the same fold,
 * in both live and replay mode. That is what lets a client that connects at
 * event 4,000 render exactly what a client connected since event 1 renders —
 * and it is the smaller half of "the frontend cannot tell a replay from a live
 * run" (IX-1, TS-5).
 *
 * The fold is pure and total: an event it does not expect leaves the state
 * unchanged rather than throwing on a socket.
 */

import type {
  Amortisation,
  MirrorSnapshot,
  Order,
  Settlement,
  SlotEvent,
  Window,
} from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import type { CumulativeAmortisation, Snapshot, StreamStatus } from "./protocol.ts";

/** Everything the fold remembers. */
export interface StreamState {
  readonly windows: ReadonlyMap<string, Window>;
  readonly orders: ReadonlyMap<string, Order>;
  readonly settlements: ReadonlyMap<string, Settlement>;
  readonly mirror: MirrorSnapshot | null;
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly l1Block: number | null;
  readonly l2Block: number | null;
  readonly blocksRemaining: number | null;
  readonly openWindowId: string | null;
  readonly seq: number;
  readonly atUnix: number;
}

/** A stream that has carried nothing yet — the honest state before block one. */
export function emptyState(): StreamState {
  return {
    windows: new Map(),
    orders: new Map(),
    settlements: new Map(),
    mirror: null,
    metrics: null,
    l1Block: null,
    l2Block: null,
    blocksRemaining: null,
    openWindowId: null,
    seq: 0,
    atUnix: 0,
  };
}

function put<V>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

/** Folds one event into the state. Pure; unknown events are a no-op. */
export function reduce(state: StreamState, event: SlotEvent): StreamState {
  const base = { ...state, seq: event.seq, atUnix: event.atUnix };

  switch (event.kind) {
    case "slot":
      return { ...base, l1Block: event.l1Block, openWindowId: event.windowId };
    case "l2_block":
      return {
        ...base,
        l2Block: event.l2Block,
        blocksRemaining: event.blocksRemaining,
        openWindowId: event.windowId,
      };
    case "window": {
      const windows = put(base.windows, event.window.windowId, event.window);
      const open = event.window.state === "open" ? event.window.windowId : base.openWindowId;
      return { ...base, windows, openWindowId: open };
    }
    case "order":
      return { ...base, orders: put(base.orders, event.order.id, event.order) };
    case "settlement":
      return { ...base, settlements: put(base.settlements, event.settlement.id, event.settlement) };
    case "mirror":
      return { ...base, mirror: event.mirror };
    case "metrics":
      return { ...base, metrics: event.metrics };
    default:
      return state;
  }
}

/** How many orders the open window is holding. Zero is an answer (FE-10). */
export function openOrderCount(state: StreamState): number {
  if (state.openWindowId === null) return 0;
  let count = 0;
  for (const order of state.orders.values()) {
    if (order.windowId === state.openWindowId && (order.state === "open" || order.state === "selected")) {
      count += 1;
    }
  }
  return count;
}

/** Every settlement's IX-3 figures, in settlement order. */
export function amortisations(state: StreamState): readonly Amortisation[] {
  return [...state.settlements.values()]
    .map((settlement) => settlement.amortisation)
    .filter((a): a is Amortisation => a !== null);
}

/** FE-6's cumulative half, summed from the same per-settlement figures. */
export function cumulative(state: StreamState): CumulativeAmortisation {
  let fills = 0;
  let l1 = 0n;
  let counterfactual = 0n;
  const perSettlement = amortisations(state);

  for (const entry of perSettlement) {
    fills += entry.fills;
    l1 += BigInt(entry.l1GasCostWei);
    counterfactual += BigInt(entry.counterfactualGasCostWei);
  }

  return {
    settlements: perSettlement.length,
    fills,
    l1GasCostWei: l1.toString(),
    counterfactualGasCostWei: counterfactual.toString(),
    savingsWei: (counterfactual - l1).toString(),
    gasPerFillWei: fills === 0 ? null : (l1 / BigInt(fills)).toString(),
  };
}

/** Windows in id order, which is the order they opened in. */
function orderedWindows(state: StreamState): readonly Window[] {
  return [...state.windows.values()].sort((a, b) =>
    BigInt(a.windowId) < BigInt(b.windowId) ? -1 : BigInt(a.windowId) > BigInt(b.windowId) ? 1 : 0,
  );
}

/** The REST body: the fold's state, plus the status that frames it. */
export function toSnapshot(state: StreamState, status: StreamStatus): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    seq: state.seq,
    windows: orderedWindows(state),
    // Ascending by id, the same order the settler resolves ties in (SV-2).
    orders: [...state.orders.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    settlements: [...state.settlements.values()],
    mirror: state.mirror,
    metrics: state.metrics,
    l1Block: state.l1Block,
    l2Block: state.l2Block,
    blocksRemaining: state.blocksRemaining,
    amortisation: { perSettlement: amortisations(state), cumulative: cumulative(state) },
  };
}
