/**
 * The reducer against A.4 — RD-2 TS-5, FE-11.
 *
 * TS-5 asks for a reducer unit test for **every** order and window transition.
 * The two tables are read from the frozen schema rather than transcribed, and
 * each is walked to exhaustion, so a state added upstream fails here instead
 * of silently going unrendered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrderState, WindowState } from "@eez-dex/indexer/schema";
import { ORDER_TRANSITIONS, WINDOW_TRANSITIONS } from "@eez-dex/indexer/schema";

import { emptyChain, foldAll, foldChain, seedChain, MIRROR_HISTORY_LIMIT } from "../src/state/chain.ts";
import {
  blockEvent,
  mirror,
  mirrorEvent,
  order,
  orderEvent,
  resetSeq,
  settlement,
  settlementEvent,
  slotEvent,
  START_UNIX,
  window,
  windowEvent,
} from "./factory.ts";

/** Every `from -> to` the frozen order machine allows. */
const ORDER_EDGES: readonly (readonly [OrderState, OrderState])[] = Object.entries(ORDER_TRANSITIONS).flatMap(
  ([from, tos]) => tos.map((to) => [from as OrderState, to] as const),
);

/** Every `from -> to` the frozen window machine allows. */
const WINDOW_EDGES: readonly (readonly [WindowState, WindowState])[] = Object.entries(WINDOW_TRANSITIONS).flatMap(
  ([from, tos]) => tos.map((to) => [from as WindowState, to] as const),
);

test("ts5: every A.4 order transition folds and is recorded as legal", () => {
  assert.ok(ORDER_EDGES.length >= 9, "the order machine should have every A.4 edge");

  for (const [from, to] of ORDER_EDGES) {
    resetSeq();
    const state = foldAll([orderEvent(order("0xaa", from)), orderEvent(order("0xaa", to))]);
    const moved = state.transitions.at(-1);

    assert.equal(state.orders.get("0xaa")?.state, to, `${from} -> ${to} should land in ${to}`);
    assert.deepEqual(
      { from: moved?.from, to: moved?.to, legal: moved?.legal, subject: moved?.subject },
      { from, to, legal: true, subject: "order" },
      `${from} -> ${to} should be recorded as a legal order transition`,
    );
  }
});

test("ts5: every A.4 window transition folds and is recorded as legal", () => {
  assert.ok(WINDOW_EDGES.length >= 7, "the window machine should have every A.4 edge");

  for (const [from, to] of WINDOW_EDGES) {
    resetSeq();
    const state = foldAll([windowEvent(window("7", from)), windowEvent(window("7", to))]);
    const moved = state.transitions.at(-1);

    assert.equal(state.windows.get("7")?.state, to);
    assert.deepEqual(
      { from: moved?.from, to: moved?.to, legal: moved?.legal, subject: moved?.subject },
      { from, to, legal: true, subject: "window" },
      `${from} -> ${to} should be recorded as a legal window transition`,
    );
  }
});

test("ts5: a transition A.4 forbids is folded but recorded as illegal", () => {
  resetSeq();
  // `cancelled` is terminal in the frozen table: an order that leaves it is a
  // defect upstream, and the app has to be able to say so (FE-7).
  const state = foldAll([orderEvent(order("0xbb", "cancelled")), orderEvent(order("0xbb", "open"))]);

  assert.equal(state.transitions.at(-1)?.legal, false);
  assert.equal(state.orders.get("0xbb")?.state, "open", "the stream is still folded — it is not this app's to censor");
});

test("fe11: a repeated state is not a transition", () => {
  resetSeq();
  const state = foldAll([orderEvent(order("0xcc", "open")), orderEvent(order("0xcc", "open"))]);
  assert.equal(state.transitions.length, 0);
});

test("fe11: the open window is the one that says it is open, and stops being it when it leaves", () => {
  resetSeq();
  const opened = foldAll([windowEvent(window("1", "open"))]);
  assert.equal(opened.openWindowId, "1");

  const settling = foldChain(opened, windowEvent(window("1", "settling")));
  assert.equal(settling.openWindowId, null, "a settling window is not open");

  const next = foldChain(settling, windowEvent(window("2", "open")));
  assert.equal(next.openWindowId, "2");
});

test("fe12: slot and block ticks are the only clocks the fold has", () => {
  resetSeq();
  const state = foldAll([
    windowEvent(window("0", "open")),
    blockEvent(11, "0", 5, START_UNIX + 2),
    slotEvent(1001, "0", START_UNIX + 12),
  ]);

  assert.equal(state.l2Block, 11);
  assert.equal(state.blocksRemaining, 5);
  assert.equal(state.l1Block, 1001);
  assert.equal(state.block?.atUnix, START_UNIX + 2);
  assert.equal(state.slot?.atUnix, START_UNIX + 12);
  assert.equal(state.atUnix, START_UNIX + 12, "the fold's clock is the last event, never the browser's");
});

test("fe8: mirror snapshots accumulate newest first and are capped", () => {
  resetSeq();
  const events = Array.from({ length: MIRROR_HISTORY_LIMIT + 4 }, (_, index) =>
    mirrorEvent(mirror(String(index), { l1Block: 1000 + index, source: "settlement" })),
  );
  const state = foldAll(events);

  assert.equal(state.mirrorHistory.length, MIRROR_HISTORY_LIMIT);
  assert.equal(state.mirrorHistory[0]?.l1Block, 1000 + MIRROR_HISTORY_LIMIT + 3);
  assert.equal(state.mirror?.l1Block, 1000 + MIRROR_HISTORY_LIMIT + 3);
});

test("fe11: settlements are kept in observation order", () => {
  resetSeq();
  const state = foldAll([
    settlementEvent(settlement("0xs1")),
    settlementEvent(settlement("0xs2", { windowId: "1" })),
    settlementEvent(settlement("0xs1", { outcome: "rolled_back", rollbackCause: "postbatch_skip", l1GasSpent: true })),
  ]);

  assert.deepEqual([...state.settlementIds], ["0xs1", "0xs2"]);
  assert.equal(state.settlements.get("0xs1")?.outcome, "rolled_back");
  assert.equal(state.settlements.get("0xs1")?.l1GasSpent, true);
});

test("fe10: folding a prefix is what seeking is, and it is pure", () => {
  resetSeq();
  const events = [
    windowEvent(window("0", "open")),
    orderEvent(order("0xdd", "open")),
    orderEvent(order("0xdd", "selected")),
    orderEvent(order("0xdd", "filled")),
  ];

  const half = foldAll(events.slice(0, 2));
  const whole = foldAll(events);
  const again = foldAll(events);

  assert.equal(half.orders.get("0xdd")?.state, "open");
  assert.equal(whole.orders.get("0xdd")?.state, "filled");
  assert.deepEqual(again, whole, "the same events fold to the same state");
  assert.deepEqual(foldAll(events.slice(0, 2)), half, "and a prefix always folds to the same prefix state");
});

test("fe11: an empty chain claims nothing", () => {
  const state = emptyChain();
  assert.deepEqual(
    {
      windows: state.windows.size,
      orders: state.orders.size,
      mirror: state.mirror,
      metrics: state.metrics,
      l1Block: state.l1Block,
      events: state.events,
    },
    { windows: 0, orders: 0, mirror: null, metrics: null, l1Block: null, events: 0 },
  );
});

test("ix1: a REST snapshot seeds state without inventing transitions", () => {
  const state = seedChain({
    windows: [window("3", "open")],
    orders: [order("0xee", "open", { windowId: "3" })],
    settlements: [settlement("0xs9", { windowId: "3" })],
    mirror: mirror("3"),
    metrics: { roll_rate: 0.014 },
    l1Block: 1000,
    l2Block: 10,
    blocksRemaining: 4,
    openWindowId: "3",
    seq: 4000,
    atUnix: START_UNIX,
  });

  assert.equal(state.transitions.length, 0, "nothing was observed to move");
  assert.equal(state.openWindowId, "3");
  assert.equal(state.seq, 4000);
  assert.equal(state.mirrorHistory.length, 1);
  assert.equal(state.metrics?.["roll_rate"], 0.014);
});
