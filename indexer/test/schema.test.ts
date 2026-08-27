/**
 * The frozen schema, pinned — RD-2 IX-2, TS-5.
 *
 * These are not tests of the indexer; they are tests of the contract three
 * phases share. A change that breaks one of them breaks WP-4's fixture, WP-5's
 * stream and WP-6's reducer at once, which is exactly the signal wanted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  METRIC_NAMES,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  SCHEMA_VERSION,
  SIDES,
  SLOT_EVENT_KINDS,
  WINDOW_OUTCOMES,
  WINDOW_STATES,
  WINDOW_TRANSITIONS,
  canTransition,
} from "../schema/index.ts";
import type { Order, SlotEvent, Window } from "../schema/index.ts";

test("ix2: the schema is versioned in one place", () => {
  assert.equal(typeof SCHEMA_VERSION, "number");
  assert.ok(SCHEMA_VERSION >= 1);
});

test("a4: the window state machine is exactly the spec's", () => {
  assert.deepEqual([...WINDOW_STATES], ["open", "settling", "settled", "evicted", "rolled_back"]);
  assert.ok(canTransition(WINDOW_TRANSITIONS, "open", "settling"));
  assert.ok(canTransition(WINDOW_TRANSITIONS, "settling", "evicted"));
  // An evicted or rolled-back window returns to open with its orders intact.
  assert.ok(canTransition(WINDOW_TRANSITIONS, "evicted", "open"));
  assert.ok(canTransition(WINDOW_TRANSITIONS, "rolled_back", "open"));
  // A settled window can still be rolled back: the bundle can be missed or
  // reorged after the L2 blocks were produced.
  assert.ok(canTransition(WINDOW_TRANSITIONS, "settled", "rolled_back"));
  // A window never settles without first settling.
  assert.ok(!canTransition(WINDOW_TRANSITIONS, "open", "settled"));
});

test("a4: the order state machine is exactly the spec's", () => {
  assert.deepEqual([...ORDER_STATES], ["open", "selected", "filled", "rolled", "cancelled", "expired"]);
  assert.ok(canTransition(ORDER_TRANSITIONS, "open", "selected"));
  assert.ok(canTransition(ORDER_TRANSITIONS, "selected", "filled"));
  // A rolled order is not terminal: it remains open in the next window (FL-8).
  assert.ok(canTransition(ORDER_TRANSITIONS, "rolled", "open"));
  // A rolled-back bundle undoes fills.
  assert.ok(canTransition(ORDER_TRANSITIONS, "filled", "open"));
  // Cancelled and expired are terminal.
  assert.deepEqual([...ORDER_TRANSITIONS.cancelled], []);
  assert.deepEqual([...ORDER_TRANSITIONS.expired], []);
});

test("a1: sides are named, not ordinal", () => {
  assert.deepEqual([...SIDES], ["SELL_A_FOR_B", "SELL_B_FOR_A"]);
});

test("ix2: every event kind is in the SlotEvent union", () => {
  assert.deepEqual(
    [...SLOT_EVENT_KINDS],
    ["slot", "l2_block", "window", "order", "settlement", "mirror", "metrics"],
  );
});

test("ix2: a window and an order round-trip through JSON unchanged", () => {
  const window: Window = {
    schemaVersion: SCHEMA_VERSION,
    windowId: "18446744073709551615",
    state: "settled",
    slots: 2,
    openedAtL2Block: 1024,
    openedAtUnix: 1_756_000_000,
    syncL2Block: 1030,
    orderIds: ["0xaa", "0xbb"],
    selectedOrderIds: ["0xaa"],
    settlementId: "0xcc",
    grossIn: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    residualIn: "1000000000000000000",
    residualSide: "SELL_A_FOR_B",
    nettingRatio: 0.23,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(window)), window);

  const order: Order = {
    schemaVersion: SCHEMA_VERSION,
    id: "0xaa",
    owner: "0x00000000000000000000000000000000000000a1",
    side: "SELL_A_FOR_B",
    sellAmount: "1000000000000000000",
    minBuyAmount: "990000000000000000",
    recipient: "0x00000000000000000000000000000000000000a1",
    expiresAfter: 4_294_967_295,
    state: "filled",
    placedAtL2Block: 1025,
    placedAtUnix: 1_756_000_002,
    windowId: "18446744073709551615",
    rolledCount: 0,
    fill: {
      windowId: "18446744073709551615",
      amountOut: "995000000000000000",
      feeAmount: "100000000000000",
      routeFeeAmount: "0",
      impactAmount: "4900000000000000",
      priceX96: "79228162514264337593543950336",
      crossed: false,
      settlementId: "0xcc",
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(order)), order);

  // Widths that a double would silently lose survive as strings.
  assert.equal(JSON.parse(JSON.stringify(window)).grossIn, window.grossIn);
});

test("ix2: a SlotEvent narrows by kind, which is what the reducer relies on", () => {
  const event: SlotEvent = {
    schemaVersion: SCHEMA_VERSION,
    seq: 7,
    kind: "l2_block",
    atUnix: 1_756_000_002,
    l2Block: 1025,
    windowId: "1",
    blocksRemaining: 5,
  };
  assert.equal(event.kind === "l2_block" ? event.blocksRemaining : null, 5);
});

test("a5: the metric names have not drifted from settler/src/config.rs", () => {
  const configRs = fileURLToPath(new URL("../../settler/src/config.rs", import.meta.url));
  const source = readFileSync(configRs, "utf8");

  for (const name of METRIC_NAMES) {
    assert.ok(source.includes(`: &str = "${name}";`), `${name} is missing from settler/src/config.rs`);
  }
  const declared = source.match(/pub const [A-Z0-9_]+: &str = "([a-z0-9_]+)";/g) ?? [];
  assert.equal(declared.length, METRIC_NAMES.length, "the two metric lists must be the same length");

  for (const outcome of WINDOW_OUTCOMES) {
    assert.ok(source.includes(`"${outcome}"`), `${outcome} is missing from settler/src/config.rs`);
  }
});
