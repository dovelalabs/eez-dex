/**
 * Event fixtures built by hand, for the transitions a recording cannot cover.
 *
 * The HX-5 recordings are the end-to-end input (TS-5) and they carry real
 * numbers; these carry one thing each, so a reducer test can name the A.4
 * transition it is pinning and nothing else moves underneath it.
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
import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

/** The clock every hand-built fixture starts at. Pinned, so a diff is a change. */
export const START_UNIX = 1_788_000_000;

let sequence = 0;

/** The next sequence number, so a test's events are monotonic by construction. */
export function nextSeq(): number {
  sequence += 1;
  return sequence;
}

/** Restarts the sequence, so each test reads from one. */
export function resetSeq(): void {
  sequence = 0;
}

export function window(windowId: string, state: WindowState, extra: Partial<Window> = {}): Window {
  return {
    schemaVersion: SCHEMA_VERSION,
    windowId,
    state,
    slots: 1,
    openedAtL2Block: 1,
    openedAtUnix: START_UNIX,
    syncL2Block: null,
    orderIds: [],
    selectedOrderIds: [],
    settlementId: null,
    grossIn: "0",
    residualIn: "0",
    residualSide: null,
    nettingRatio: null,
    ...extra,
  };
}

export function order(id: string, state: OrderState, extra: Partial<Order> = {}): Order {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    owner: "0x00000000000000000000000000000000000000a1",
    side: "SELL_A_FOR_B",
    sellAmount: "1000000000000000000",
    minBuyAmount: "2900000000000000000000",
    recipient: "0x00000000000000000000000000000000000000a1",
    expiresAfter: 1,
    state,
    placedAtL2Block: 2,
    placedAtUnix: START_UNIX,
    windowId: "0",
    rolledCount: 0,
    fill: null,
    ...extra,
  };
}

export function settlement(id: string, extra: Partial<Settlement> = {}): Settlement {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    windowId: "0",
    outcome: "settled",
    leg: {
      windowId: "0",
      residualSide: "SELL_A_FOR_B",
      residualIn: "1000000000000000000",
      minPriceX96: "0",
      maxPriceX96: "0",
      deadline: START_UNIX + 24,
    },
    result: null,
    l1Receipt: null,
    rollbackCause: null,
    l1GasSpent: false,
    filledOrderIds: [],
    droppedOrderIds: [],
    submittedAtUnix: START_UNIX + 10,
    settledAtUnix: null,
    amortisation: null,
    ...extra,
  };
}

export function mirror(windowId: string, extra: Partial<MirrorSnapshot> = {}): MirrorSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    windowId,
    state: {
      sqrtPriceX96: "4339505179874779489431521786241",
      liquidity: "2000000000000000000000000",
      tick: 80067,
    },
    referencePriceX96: "237684487542793012780631851007941",
    l1Block: 1000,
    mirrorTimestamp: START_UNIX,
    ageSlots: 0,
    source: "genesis",
    observedAtUnix: START_UNIX,
    ...extra,
  };
}

/** Wraps any of the above in its stream envelope. */
export function event(payload: Omit<SlotEvent, "schemaVersion" | "seq" | "atUnix"> & { atUnix?: number }): SlotEvent {
  const { atUnix, ...rest } = payload as Record<string, unknown> & { atUnix?: number };
  return {
    schemaVersion: SCHEMA_VERSION,
    seq: nextSeq(),
    atUnix: atUnix ?? START_UNIX,
    ...rest,
  } as SlotEvent;
}

/** A window event. */
export function windowEvent(value: Window, atUnix?: number): SlotEvent {
  return event({ kind: "window", window: value, ...(atUnix === undefined ? {} : { atUnix }) } as never);
}

/** An order event. */
export function orderEvent(value: Order, atUnix?: number): SlotEvent {
  return event({ kind: "order", order: value, ...(atUnix === undefined ? {} : { atUnix }) } as never);
}

/** A settlement event. */
export function settlementEvent(value: Settlement, atUnix?: number): SlotEvent {
  return event({ kind: "settlement", settlement: value, ...(atUnix === undefined ? {} : { atUnix }) } as never);
}

/** A mirror event. */
export function mirrorEvent(value: MirrorSnapshot, atUnix?: number): SlotEvent {
  return event({ kind: "mirror", mirror: value, ...(atUnix === undefined ? {} : { atUnix }) } as never);
}

/** An L2 block tick. */
export function blockEvent(l2Block: number, windowId: string, blocksRemaining: number, atUnix: number): SlotEvent {
  return event({ kind: "l2_block", l2Block, windowId, blocksRemaining, atUnix } as never);
}

/** An L1 slot tick. */
export function slotEvent(l1Block: number, windowId: string, atUnix: number): SlotEvent {
  return event({ kind: "slot", l1Block, windowId, atUnix } as never);
}
