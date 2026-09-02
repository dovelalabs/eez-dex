/**
 * The app reducer around the fold — RD-2 FE-10, FE-11, FE-12.
 *
 * The chain fold is tested in `reduce.test.ts`; what is tested here is the
 * layer that makes three modes one code path: frames in, a scrubber that seeks
 * by re-folding, a clock that only moves forward, and the wallet session — the
 * one piece of state that is the user's rather than the chain's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Snapshot, StreamStatus } from "@eez-dex/indexer";
import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

import { readConfig } from "../src/config.ts";
import { initialState, reduce, type AppState } from "../src/state/app.ts";
import { mirror, order, orderEvent, resetSeq, settlement, START_UNIX, window, windowEvent } from "./factory.ts";

const CONFIG = readConfig({}, "?mode=replay");

function start(): AppState {
  resetSeq();
  return initialState(CONFIG);
}

function feed(state: AppState, events: readonly ReturnType<typeof windowEvent>[]): AppState {
  return events.reduce((current, event) => reduce(current, { type: "frame", frame: { type: "event", event } }), state);
}

const STATUS: StreamStatus = {
  schemaVersion: SCHEMA_VERSION,
  mode: "replay",
  profile: "devnet",
  activity: "active",
  seq: 7,
  atUnix: START_UNIX + 5,
  sources: [{ source: "fixture", state: "ok", detail: null, observedAtUnix: START_UNIX }],
  openWindowId: "0",
  openOrders: 1,
  l1Pool: null,
  replay: { speed: 1, position: 7, total: 40, startedAtUnix: START_UNIX, endsAtUnix: START_UNIX + 60 },
};

test("fe11: the initial state claims nothing about a chain it has not seen", () => {
  const state = start();
  assert.equal(state.connection, "idle");
  assert.equal(state.status, null);
  assert.equal(state.nowUnix, 0);
  assert.equal(state.log.length, 0);
  assert.equal(state.wallet.state, "absent");
});

test("fe11: an event frame lands in the log and in the fold", () => {
  const state = feed(start(), [windowEvent(window("0", "open")), orderEvent(order("0xa1", "open"))]);

  assert.equal(state.log.length, 2);
  assert.equal(state.chain.windows.size, 1);
  assert.equal(state.chain.orders.get("0xa1")?.state, "open");
  assert.equal(state.nowUnix, START_UNIX, "the clock follows the events received");
});

test("ix1: a snapshot frame seeds the world a late joiner starts from", () => {
  const snapshot: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    status: STATUS,
    seq: 7,
    windows: [window("0", "open")],
    orders: [order("0xa1", "open")],
    settlements: [settlement("0xs1")],
    mirror: mirror("0"),
    metrics: { roll_rate: 0.02 },
    l1Block: 1000,
    l2Block: 4,
    blocksRemaining: 2,
    amortisation: {
      perSettlement: [],
      cumulative: {
        settlements: 0,
        fills: 0,
        l1GasCostWei: "0",
        counterfactualGasCostWei: "0",
        savingsWei: "0",
        gasPerFillWei: null,
      },
    },
  };

  const state = reduce(start(), { type: "frame", frame: { type: "snapshot", snapshot } });
  assert.equal(state.chain.orders.size, 1);
  assert.equal(state.chain.blocksRemaining, 2);
  assert.equal(state.status?.activity, "active");
  assert.equal(state.replay?.total, 40);
});

test("fe10: seeking parks the view, and following re-folds everything received", () => {
  const events = [
    windowEvent(window("0", "open")),
    orderEvent(order("0xa1", "open")),
    orderEvent(order("0xa1", "selected")),
    orderEvent(order("0xa1", "filled")),
  ];
  const live = feed(start(), events);
  assert.equal(live.chain.orders.get("0xa1")?.state, "filled");

  const parked = reduce(live, { type: "seek", position: 2 });
  assert.equal(parked.scrubbedTo, 2);
  assert.equal(parked.chain.orders.get("0xa1")?.state, "open", "the view is the moment scrubbed to");
  assert.equal(parked.log.length, 4, "the tape is not truncated by looking at it");

  // Events that arrive while parked accumulate without moving the view.
  const arrived = reduce(parked, {
    type: "frame",
    frame: { type: "event", event: orderEvent(order("0xa2", "open")) },
  });
  assert.equal(arrived.log.length, 5);
  assert.equal(arrived.chain.orders.has("0xa2"), false);

  const following = reduce(arrived, { type: "seek", position: null });
  assert.equal(following.scrubbedTo, null);
  assert.equal(following.chain.orders.get("0xa1")?.state, "filled");
  assert.equal(following.chain.orders.has("0xa2"), true);
});

test("fe10: seeking past either end of the tape is clamped rather than refused", () => {
  const live = feed(start(), [windowEvent(window("0", "open"))]);
  assert.equal(reduce(live, { type: "seek", position: 99 }).scrubbedTo, 1);
  assert.equal(reduce(live, { type: "seek", position: -5 }).scrubbedTo, 0);
});

test("fe12: the clock only moves forward, and only when something says so", () => {
  const state = reduce(start(), { type: "tick", nowUnix: 100 });
  assert.equal(state.nowUnix, 100);
  assert.equal(reduce(state, { type: "tick", nowUnix: 90 }).nowUnix, 100, "a late tick cannot rewind the clock");
  assert.equal(reduce(state, { type: "tick", nowUnix: 101 }).nowUnix, 101);
});

test("fe11: connection state is carried, never swallowed", () => {
  const failed = reduce(start(), { type: "connection", state: "failed", detail: "schema version 2" });
  assert.equal(failed.connection, "failed");
  assert.equal(failed.connectionDetail, "schema version 2");
});

test("fe2: a submission is signing or submitted — there is no confirmed", () => {
  const state = reduce(start(), {
    type: "submission",
    submission: { kind: "place", state: "submitted", txHash: "0xdead", orderId: null, detail: null, atUnix: 1 },
  });
  assert.equal(state.submissions[0]?.state, "submitted");
  assert.equal(state.submissions.length, 1);
});

test("fe1: wallet and form updates merge rather than replace", () => {
  const connected = reduce(start(), { type: "wallet", wallet: { state: "connected", address: "0xabc" } });
  const named = reduce(connected, { type: "wallet", wallet: { providerName: "Test wallet" } });
  assert.equal(named.wallet.address, "0xabc");
  assert.equal(named.wallet.providerName, "Test wallet");

  const typed = reduce(named, { type: "form", form: { sellText: "1.5" } });
  const flipped = reduce(typed, { type: "form", form: { side: "SELL_B_FOR_A" } });
  assert.equal(flipped.form.sellText, "1.5");
  assert.equal(flipped.form.side, "SELL_B_FOR_A");
  assert.equal(flipped.form.slippageBps, 50);
});
