/**
 * The live path, and its honesty — RD-2 IX-1, IX-3, A.4, §7 preamble.
 *
 * "Windows on a live chain are often quiet. The stream must represent empty,
 * loading and error states as first-class data, never as absent fields the
 * frontend has to guess at — the frontend is forbidden from inventing
 * activity." These tests are that sentence, held to.
 *
 * They also pin the two rules the fold runs on: never invent a transition
 * (A.4's tables are walked), and never invent a number (every fill figure is
 * derived from what CT-12 emitted).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ORDER_TRANSITIONS, WINDOW_TRANSITIONS, canTransition } from "../schema/index.ts";
import type { Order, Settlement, SlotEvent, Window } from "../schema/index.ts";
import { amortisationFor } from "../src/amortisation.ts";
import { EMPTY_GAS_SAMPLE, sampleSwapGas, type Receipt } from "../src/chain/l1.ts";
import { EventHub } from "../src/hub.ts";
import { orderPath, windowPath } from "../src/machine.ts";
import { Q96, fillPriceX96, notionalInA, spotPriceX96 } from "../src/price.ts";
import { loading } from "../src/protocol.ts";
import { LiveSource } from "../src/sources/live.ts";
import { BOOK, FakeL1, FakeL2, ORDERS, OWNERS, POOL_ADAPTER, PRICE_X96 } from "./fakechain.ts";
import { recordScriptedRun } from "./script.ts";

function hubOf(): EventHub {
  return new EventHub({
    mode: "live",
    profile: "devnet",
    now: () => 1_800_000_000,
    sources: [loading("l2"), loading("l1"), loading("settler")],
  });
}

function events(hub: EventHub): readonly SlotEvent[] {
  return hub.events(0);
}

test("§7: an upstream that is not answering is a fact, with a reason", async () => {
  const hub = hubOf();
  const broken = {
    name: "l2",
    call: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8545");
    },
  };
  const source = new LiveSource({ l2: broken, l1: null, windowBook: BOOK, settlerUrl: null }, hub);
  await source.tick();

  const status = hub.status();
  const l2 = status.sources.find((entry) => entry.source === "l2");
  assert.equal(l2?.state, "unavailable");
  assert.match(l2?.detail ?? "", /ECONNREFUSED/);
  // Nothing was emitted: a chain that did not answer is not a quiet chain.
  assert.deepEqual(events(hub), []);
  assert.equal(status.activity, "loading");
});

test("§7: an upstream that is not configured says so, and says what is missing", async () => {
  const hub = hubOf();
  const source = new LiveSource({ l2: new FakeL2(), l1: null, windowBook: BOOK, settlerUrl: null }, hub);
  await source.tick();

  const sources = hub.status().sources;
  assert.equal(sources.find((entry) => entry.source === "l1")?.state, "absent");
  assert.match(sources.find((entry) => entry.source === "l1")?.detail ?? "", /IX-3/);
  assert.equal(sources.find((entry) => entry.source === "settler")?.state, "absent");
  assert.match(sources.find((entry) => entry.source === "settler")?.detail ?? "", /evictions and rollbacks/);
});

test("§7: a quiet window is empty data, not missing data", async () => {
  const hub = hubOf();
  const l2 = new FakeL2();
  const source = new LiveSource({ l2, l1: new FakeL1(), windowBook: BOOK, settlerUrl: null }, hub);
  await source.tick();

  const window = events(hub).find((event) => event.kind === "window");
  assert.equal(window?.kind, "window");
  if (window?.kind !== "window") return;
  assert.deepEqual(window.window.orderIds, []);
  assert.equal(window.window.state, "open");
  // The status says quiet, not broken and not loading.
  assert.equal(hub.status().activity, "empty");
  assert.equal(hub.status().openOrders, 0);
  assert.equal(hub.status().openWindowId, "1");

  // And the mirror is there with its age, which every quote carries (FL-2).
  const mirror = events(hub).find((event) => event.kind === "mirror");
  assert.equal(mirror?.kind === "mirror" ? mirror.mirror.ageSlots : null, 1);
});

test("ix1: the L1 pool's live state is read beside the mirror it is copied to", async () => {
  const hub = hubOf();
  const l1 = new FakeL1();
  const source = new LiveSource(
    { l2: new FakeL2(), l1, windowBook: BOOK, settlerUrl: null, poolAdapter: POOL_ADAPTER },
    hub,
  );
  await source.tick();

  const status = hub.status();
  assert.equal(status.l1Pool?.l1Block, l1.head);
  assert.equal(status.l1Pool?.state.tick, l1.pool.tick);
  assert.equal(status.l1Pool?.state.liquidity, l1.pool.liquidity.toString());

  // FE-7, FE-8: the head has moved under the mirror, and both are served, so
  // neither the theater nor the inspector has to derive the gap itself.
  const mirror = events(hub).find((event) => event.kind === "mirror");
  assert.equal(mirror?.kind === "mirror" ? mirror.mirror.state.tick : null, 76_012);
  assert.notEqual(status.l1Pool?.state.tick, 76_012);
});

test("ix1: with no pool adapter configured the live state is null, not invented", async () => {
  const hub = hubOf();
  const source = new LiveSource({ l2: new FakeL2(), l1: new FakeL1(), windowBook: BOOK, settlerUrl: null }, hub);
  await source.tick();

  // Null is the answer, and it is present: never an absent field (§7 preamble).
  assert.equal(hub.status().l1Pool, null);
  assert.ok("l1Pool" in hub.status());
});

test("ix1: an adapter that does not answer is an L1 error, not a stale price", async () => {
  const hub = hubOf();
  const l1 = new FakeL1();
  const source = new LiveSource(
    { l2: new FakeL2(), l1, windowBook: BOOK, settlerUrl: null, poolAdapter: BOOK },
    hub,
  );
  await source.tick();

  const status = hub.status();
  assert.equal(status.sources.find((entry) => entry.source === "l1")?.state, "unavailable");
  assert.equal(status.l1Pool, null);
});

test("ix1: a re-read of the same range emits nothing twice", async () => {
  const hub = hubOf();
  const l2 = new FakeL2();
  const source = new LiveSource({ l2, l1: null, windowBook: BOOK, settlerUrl: null, fromBlock: 0 }, hub);
  l2.place(ORDERS.alice, OWNERS.alice, 0, 10n ** 18n, 1n);
  await source.tick();
  const first = events(hub).length;
  await source.tick();

  const orders = events(hub).filter((event) => event.kind === "order");
  assert.equal(orders.length, 1, "one placement, one order event");
  assert.ok(events(hub).length >= first);
});

test("a4: a settlement seen without its submission still passes through settling", async () => {
  const { events: recorded } = await recordScriptedRun();
  const states = recorded
    .filter((event): event is Extract<SlotEvent, { kind: "window" }> => event.kind === "window")
    .filter((event) => event.window.windowId === "1")
    .map((event) => event.window.state);

  assert.deepEqual([...new Set(states)], ["open", "settling", "settled"]);
  // Every consecutive pair is a transition A.4 allows.
  for (const [index, state] of states.slice(1).entries()) {
    const previous = states[index]!;
    assert.ok(previous === state || canTransition(WINDOW_TRANSITIONS, previous, state), `${previous} -> ${state}`);
  }
});

test("a4: the machine walk is the shortest legal path, and refuses impossible ones", () => {
  assert.deepEqual(windowPath("open", "settled"), ["settling", "settled"]);
  assert.deepEqual(windowPath("open", "evicted"), ["settling", "evicted"]);
  assert.deepEqual(windowPath("settled", "rolled_back"), ["rolled_back"]);
  assert.deepEqual(windowPath("open", "open"), []);
  assert.deepEqual(orderPath("rolled", "filled"), ["open", "selected", "filled"]);
  // Cancelled and expired are terminal (A.4), so nothing leads out of them.
  assert.throws(() => orderPath("cancelled", "open"));
  assert.deepEqual([...ORDER_TRANSITIONS.expired], []);
});

test("fl5, ct12: a crossed fill clears at P0 and a residual fill below it", async () => {
  const { hub } = await recordScriptedRun();
  const orders = new Map(hub.snapshot().orders.map((order: Order) => [order.id, order]));

  const alice = orders.get(ORDERS.alice)!;
  const bob = orders.get(ORDERS.bob)!;
  assert.equal(alice.fill?.crossed, false, "the residual side sold A");
  assert.equal(bob.fill?.crossed, true, "the opposing side crossed inside the window");

  // Bob crossed: exactly the reference price, no impact, no windfall (FL-5).
  assert.equal(bob.fill?.priceX96, PRICE_X96.toString());
  assert.equal(bob.fill?.impactAmount, "0");

  // Alice is on the residual side: the reference price less her impact share.
  assert.ok(BigInt(alice.fill!.priceX96) < PRICE_X96);
  assert.ok(BigInt(alice.fill!.impactAmount) > 0n);

  // And the price is the amounts the chain emitted, not a re-derivation.
  const netIn = BigInt(alice.sellAmount) - BigInt(alice.fill!.feeAmount) - BigInt(alice.fill!.routeFeeAmount);
  assert.equal(alice.fill?.priceX96, fillPriceX96(netIn, BigInt(alice.fill!.amountOut), alice.side));
  assert.ok(BigInt(alice.fill!.amountOut) >= BigInt(alice.minBuyAmount), "CT-10: never below the limit");
});

test("fl8: an order whose limit was not met rolls into the next window, intact", async () => {
  const { events: recorded } = await recordScriptedRun();
  const carol = recorded
    .filter((event): event is Extract<SlotEvent, { kind: "order" }> => event.kind === "order")
    .filter((event) => event.order.id === ORDERS.carol)
    .map((event) => event.order);

  const rolled = carol.find((order) => order.state === "rolled");
  assert.ok(rolled, "the order that could not be filled rolled");
  assert.equal(rolled?.windowId, "2", "into the next window");
  assert.equal(rolled?.rolledCount, 1);
  assert.equal(rolled?.fill, null, "and it was not filled");
  assert.ok(carol.some((order) => order.state === "filled"), "and it filled in the window after");
});

test("fl7, sv4: an eviction is free and a rollback undoes its fills", async () => {
  const { hub } = await recordScriptedRun();
  const settlements = new Map(hub.snapshot().settlements.map((entry: Settlement) => [entry.outcome, entry]));

  const evicted = settlements.get("evicted");
  assert.ok(evicted, "the run carries a poison eviction");
  assert.equal(evicted?.l1Receipt, null, "no L1 transaction happened at all (FL-7)");
  assert.equal(evicted?.l1GasSpent, false);
  assert.deepEqual(evicted?.filledOrderIds, []);

  const rolledBack = settlements.get("rolled_back");
  assert.equal(rolledBack?.rollbackCause, "bundle_missed");
  const carol = hub.snapshot().orders.find((order: Order) => order.id === ORDERS.carol);
  assert.equal(carol?.state, "open", "the fill un-happened, and the order is open again");
  assert.equal(carol?.fill, null);

  // The window it belonged to is open again with its orders intact (A.4).
  const window = hub.snapshot().windows.find((entry: Window) => entry.windowId === "2");
  assert.equal(window?.state, "open");
  assert.equal(window?.orderIds.length, 2);
});

function receipt(from: string, gasUsed: bigint): Receipt {
  return {
    transactionHash: "0xaa",
    from,
    blockNumber: 1,
    gasUsed,
    effectiveGasPriceWei: 1_000_000_000n,
    status: "success",
    isSwap: true,
  };
}

test("ix3: the user's own last L1 swap outranks the median, and both are measured", () => {
  const sample = sampleSwapGas(
    [receipt(OWNERS.alice, 355_000n), receipt("0xother", 400_000n), receipt("0xanother", 420_000n)],
    1,
    5,
  );
  const settlement = amortisationFor({
    settlementId: "0xset",
    windowId: "1",
    filled: [
      { id: ORDERS.alice, owner: OWNERS.alice },
      { id: ORDERS.bob, owner: OWNERS.bob },
    ],
    receipt: { ...receipt("0xrouter", 214_000n), isSwap: false },
    sample,
  });

  assert.equal(settlement?.perOrder[0]?.source, "user_last_l1_swap");
  assert.equal(settlement?.perOrder[0]?.gasUsed, "355000");
  assert.equal(settlement?.perOrder[1]?.source, "median_retail_swap");
  assert.equal(settlement?.perOrder[1]?.gasUsed, "400000");

  // Amortisation is the point: one L1 transaction against two direct swaps.
  assert.equal(settlement?.fills, 2);
  assert.equal(settlement?.gasPerFillWei, "107000000000000");
  assert.equal(settlement?.counterfactualGasCostWei, "755000000000000");
  assert.equal(settlement?.savingsWei, "541000000000000");
});

test("ix3: with nothing observed there is no counterfactual, not a made-up one", () => {
  const none = amortisationFor({
    settlementId: "0xset",
    windowId: "1",
    filled: [{ id: ORDERS.alice, owner: OWNERS.alice }],
    receipt: { ...receipt("0xrouter", 214_000n), isSwap: false },
    sample: EMPTY_GAS_SAMPLE,
  });
  assert.equal(none, null, "IX-3 forbids a fixed single-hop estimate");
});

test("a1: prices are B per A in Q96 whichever way the order trades", () => {
  const l2 = new FakeL2();
  const price = spotPriceX96({
    sqrtPriceX96: l2.book.mirrorSqrtPrice.toString(),
    liquidity: l2.book.mirrorLiquidity.toString(),
    tick: l2.book.mirrorTick,
  });
  // The fake pool is at 2000 B per A, up to the sqrt price's own truncation.
  assert.equal(price / Q96, 1_999n);

  const oneA = 10n ** 18n;
  // A B-side order's notional is its amount valued in A, as the book values it.
  assert.equal(notionalInA(2_000n * oneA, "SELL_B_FOR_A", 2_000n * Q96), oneA);
  assert.equal(notionalInA(oneA, "SELL_A_FOR_B", 2_000n * Q96), oneA);

  // And a fill's price is B per A on both sides of the pair.
  assert.equal(fillPriceX96(oneA, 2_000n * oneA, "SELL_A_FOR_B"), (2_000n * Q96).toString());
  assert.equal(fillPriceX96(2_000n * oneA, oneA, "SELL_B_FOR_A"), (2_000n * Q96).toString());
});
