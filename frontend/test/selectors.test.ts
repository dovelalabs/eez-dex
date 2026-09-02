/**
 * The derived views — RD-2 FE-3, FE-5, FE-6, FE-7, FE-10, FE-12.
 *
 * These are the facts the components print. Two of them carry most of the
 * requirement: the counterfactual must be the user's own figure only when it
 * genuinely is (FE-3, IX-3), and the window's clock must show a stalled chain
 * as stalled rather than as a bar that keeps moving (FE-12).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Amortisation, PoolState, StreamStatus } from "@eez-dex/indexer";
import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

import { readConfig } from "../src/config.ts";
import { initialState, reduce, type AppState } from "../src/state/app.ts";
import {
  activity,
  counterfactualFor,
  cumulativeAmortisation,
  drift,
  historyOwnedBy,
  mirrorAgeSlots,
  openOrdersOwnedBy,
  rolledAt,
  slotClock,
  theaterWindow,
  windowSides,
} from "../src/state/selectors.ts";
import {
  blockEvent,
  mirror,
  mirrorEvent,
  order,
  orderEvent,
  resetSeq,
  settlement,
  settlementEvent,
  START_UNIX,
  window,
  windowEvent,
} from "./factory.ts";
import type { SlotEvent } from "@eez-dex/indexer/schema";

const CONFIG = readConfig({}, "?mode=observe");

function feed(events: readonly SlotEvent[], from = initialState(CONFIG)): AppState {
  return events.reduce((state, event) => reduce(state, { type: "frame", frame: { type: "event", event } }), from);
}

function at(state: AppState, nowUnix: number): AppState {
  return reduce(state, { type: "tick", nowUnix });
}

test("fe10: activity is loading, then empty, then active — a quiet chain is quiet", () => {
  resetSeq();
  assert.equal(activity(initialState(CONFIG)), "loading");

  const quiet = feed([windowEvent(window("0", "open"))]);
  assert.equal(activity(quiet), "empty", "an open window with no orders is empty, not broken");

  const busy = feed([orderEvent(order("0xa1", "open"))], quiet);
  assert.equal(activity(busy), "active");
});

test("fe10: a gateway's own activity is used verbatim when there is one", () => {
  resetSeq();
  const status: StreamStatus = {
    schemaVersion: SCHEMA_VERSION,
    mode: "live",
    profile: "testnet",
    activity: "empty",
    seq: 1,
    atUnix: START_UNIX,
    sources: [],
    openWindowId: null,
    openOrders: 0,
    l1Pool: null,
    replay: null,
  };
  const state = reduce(feed([windowEvent(window("0", "open")), orderEvent(order("0xa1", "open"))]), {
    type: "frame",
    frame: { type: "status", status },
  });
  assert.equal(activity(state), "empty");
});

test("fe5: the window's sides are indicative before it closes and the chain's after", () => {
  resetSeq();
  const open = feed([
    mirrorEvent(mirror("0")),
    windowEvent(window("0", "open")),
    orderEvent(order("0xa1", "open", { side: "SELL_A_FOR_B", sellAmount: "2000000000000000000" })),
    orderEvent(order("0xb1", "open", { side: "SELL_B_FOR_A", sellAmount: "3000000000000000000000" })),
  ]);

  const before = windowSides(open, theaterWindow(open));
  assert.ok(before !== null);
  assert.equal(before.settled, false);
  assert.equal(before.sellA, 2n * 10n ** 18n);
  assert.equal(before.sellB, 3000n * 10n ** 18n);
  assert.ok(before.crossedInA > 0n, "the smaller side crosses");
  assert.equal(before.residualSide, "SELL_A_FOR_B", "the A side is larger, so the residual sells A");

  const closed = feed(
    [
      windowEvent(
        window("0", "settled", {
          grossIn: "3000000000000000000",
          residualIn: "1000000000000000000",
          residualSide: "SELL_A_FOR_B",
          nettingRatio: 0.6667,
        }),
      ),
    ],
    open,
  );
  const after = windowSides(closed, theaterWindow(closed));
  assert.ok(after !== null);
  assert.equal(after.settled, true, "once closed the chain's own residual is used");
  assert.equal(after.residualInA, 10n ** 18n);
  assert.equal(after.crossedInA, 2n * 10n ** 18n);
});

test("fe12: a window with nothing arriving is stalled, not animated on", () => {
  resetSeq();
  const state = feed([windowEvent(window("0", "open")), blockEvent(2, "0", 4, START_UNIX + 2)]);

  const moving = slotClock(at(state, START_UNIX + 4), theaterWindow(state));
  assert.equal(moving?.stalled, false);
  assert.equal(moving?.blocks, 2, "six blocks less the four remaining");
  assert.equal(moving?.blocksTotal, 6);
  assert.ok((moving?.ratio ?? 0) > 0.3 && (moving?.ratio ?? 0) < 0.4);

  const stalled = slotClock(at(state, START_UNIX + 30), theaterWindow(state));
  assert.equal(stalled?.stalled, true);
  assert.equal(stalled?.ratio, 1, "the bar stops at the end of the window rather than running past it");
  assert.equal(stalled?.sinceLastEvent, 28);
});

test("fe12: an L2 block the stream never reported is never drawn as produced", () => {
  resetSeq();
  // A window that opened and then said nothing: the wall clock has run past
  // three L2 block times, and not one of those blocks exists.
  const state = at(feed([windowEvent(window("0", "open"))]), START_UNIX + 7);
  const clock = slotClock(state, theaterWindow(state));

  assert.equal(clock?.blocks, 0, "no l2_block event means no L2 block — never a synthetic tick");
  assert.equal(clock?.stalled, true, "and the window says it is stalled rather than animating on");
  assert.ok((clock?.ratio ?? 0) > 0, "the slot bar still runs on real time (FE-5)");

  // One reported block, and exactly one is drawn.
  const ticked = at(feed([blockEvent(1, "0", 5, START_UNIX + 2)], state), START_UNIX + 7);
  assert.equal(slotClock(ticked, theaterWindow(ticked))?.blocks, 1);
});

test("fe12: a two-slot window is twice as long and holds twice the blocks (EC-6)", () => {
  resetSeq();
  const state = at(feed([windowEvent(window("0", "open", { slots: 2 }))]), START_UNIX + 12);
  const clock = slotClock(state, theaterWindow(state));
  assert.equal(clock?.total, 24);
  assert.equal(clock?.blocksTotal, 12);
  assert.equal(clock?.ratio, 0.5);
});

test("fe7: drift is null when the L1 head is not observable, and signed when it is", () => {
  resetSeq();
  const state = feed([mirrorEvent(mirror("0"))]);
  assert.equal(drift(state), null, "a recording carries no L1 head");

  const moved: PoolState = { sqrtPriceX96: "4361202705721853386878429695000", liquidity: "2000000000000000000000000", tick: 80167 };
  const status: StreamStatus = {
    schemaVersion: SCHEMA_VERSION,
    mode: "live",
    profile: "devnet",
    activity: "active",
    seq: 1,
    atUnix: START_UNIX,
    sources: [],
    openWindowId: "0",
    openOrders: 0,
    l1Pool: { state: moved, l1Block: 1010, observedAtUnix: START_UNIX },
    replay: null,
  };
  const withHead = reduce(state, { type: "frame", frame: { type: "status", status } });
  const gap = drift(withHead);
  assert.ok(gap !== null);
  assert.ok(gap.bps < 0, "the L1 head moved up, so the mirror is below it");
  assert.equal(gap.l1Block, 1010);
});

test("fl2: the mirror's age advances with the clock, in whole slots", () => {
  resetSeq();
  const state = feed([mirrorEvent(mirror("0", { mirrorTimestamp: START_UNIX }))]);
  assert.equal(mirrorAgeSlots(at(state, START_UNIX + 5)), 0);
  assert.equal(mirrorAgeSlots(at(state, START_UNIX + 13)), 1);
  assert.equal(mirrorAgeSlots(at(state, START_UNIX + 25)), 2);
  assert.equal(mirrorAgeSlots(initialState(CONFIG)), null, "no mirror is not an age of zero");
});

test("fe7: the orders that rolled at a boundary are the ones the theater draws", () => {
  resetSeq();
  const state = feed([
    windowEvent(window("0", "open")),
    orderEvent(order("0xa1", "open")),
    orderEvent(order("0xa2", "open")),
    orderEvent(order("0xa1", "selected")),
    orderEvent(order("0xa1", "filled")),
    orderEvent(order("0xa2", "rolled", { rolledCount: 1 })),
  ]);

  const rolled = rolledAt(state, "0");
  assert.deepEqual(rolled.map((entry) => entry.id), ["0xa2"]);
});

test("fe6: cumulative amortisation sums the stream's own figures", () => {
  resetSeq();
  const first: Amortisation = {
    schemaVersion: SCHEMA_VERSION,
    settlementId: "0xs1",
    windowId: "0",
    fills: 8,
    l1GasUsed: "282000",
    l1GasCostWei: "282000000000000",
    gasPerFillWei: "35250000000000",
    counterfactualGasCostWei: "3200000000000000",
    savingsWei: "2918000000000000",
    perOrder: [],
  };
  const second: Amortisation = { ...first, settlementId: "0xs2", windowId: "1", fills: 2, l1GasCostWei: "100000000000000", counterfactualGasCostWei: "800000000000000", savingsWei: "700000000000000" };

  const state = feed([
    settlementEvent(settlement("0xs1", { amortisation: first })),
    settlementEvent(settlement("0xs2", { windowId: "1", amortisation: second })),
  ]);

  const total = cumulativeAmortisation(state);
  assert.equal(total.settlements, 2);
  assert.equal(total.fills, 10);
  assert.equal(total.l1GasCostWei, 382_000_000_000_000n);
  assert.equal(total.counterfactualGasCostWei, 4_000_000_000_000_000n);
  assert.equal(total.savingsWei, 3_618_000_000_000_000n);
  assert.equal(total.gasPerFillWei, 38_200_000_000_000n);
  assert.equal(total.fillsPerSettlement, 5);
});

test("fe3: the counterfactual is only 'your own' when it is the user's own order", () => {
  resetSeq();
  const mine = "0x00000000000000000000000000000000000000a1";
  const theirs = "0x00000000000000000000000000000000000000b2";
  const amortisation: Amortisation = {
    schemaVersion: SCHEMA_VERSION,
    settlementId: "0xs1",
    windowId: "0",
    fills: 2,
    l1GasUsed: "282000",
    l1GasCostWei: "282000000000000",
    gasPerFillWei: "141000000000000",
    counterfactualGasCostWei: "800000000000000",
    savingsWei: "518000000000000",
    perOrder: [
      { orderId: "0xa1", gasUsed: "400000", gasCostWei: "400000000000000", source: "user_last_l1_swap" },
      { orderId: "0xb2", gasUsed: "410000", gasCostWei: "410000000000000", source: "median_retail_swap" },
    ],
  };

  const state = feed([
    orderEvent(order("0xa1", "filled", { owner: mine })),
    orderEvent(order("0xb2", "filled", { owner: theirs })),
    settlementEvent(settlement("0xs1", { amortisation })),
  ]);

  assert.deepEqual(counterfactualFor(state, mine), { gasCostWei: 400_000_000_000_000n, source: "user_last_l1_swap" });
  assert.deepEqual(counterfactualFor(state, theirs), {
    gasCostWei: 410_000_000_000_000n,
    source: "median_retail_swap",
  });
  assert.deepEqual(counterfactualFor(state, null), {
    gasCostWei: 410_000_000_000_000n,
    source: "median_retail_swap",
  });
  assert.equal(counterfactualFor(initialState(CONFIG), mine), null, "nothing observed is null, never an estimate");
});

test("fe4: a user's open orders and history are their own", () => {
  resetSeq();
  const mine = "0x00000000000000000000000000000000000000a1";
  const state = feed([
    orderEvent(order("0xa1", "open", { owner: mine })),
    orderEvent(order("0xb2", "open", { owner: "0x00000000000000000000000000000000000000b2" })),
    orderEvent(
      order("0xa2", "filled", {
        owner: mine,
        fill: {
          windowId: "0",
          amountOut: "2999000000000000000000",
          feeAmount: "100000000000000",
          routeFeeAmount: "0",
          impactAmount: "0",
          priceX96: "237684487542793012780631851007941",
          crossed: true,
          settlementId: "0xs1",
        },
      }),
    ),
    settlementEvent(settlement("0xs1")),
  ]);

  assert.deepEqual(openOrdersOwnedBy(state, mine).map((entry) => entry.id), ["0xa1"]);
  const history = historyOwnedBy(state, mine);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.settlement?.id, "0xs1");
  assert.equal(openOrdersOwnedBy(state, null).length, 0);
});
