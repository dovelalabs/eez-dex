/**
 * The recorded run and the A.6 assertions — RD-2 HX-2, HX-3, HX-4, HX-5.
 *
 * Everything here runs without an enclave. That is deliberate: the failure
 * matrix is the integration suite and it needs Kurtosis, but the *recorder*,
 * the *oracle* and the *assertions* it is built from are pure, so they are
 * exercised by `dex-scenario.sh --self-test` on every pull request rather than
 * once a night. When the enclave run does fail, this suite is what says whether
 * the harness or the chain is at fault.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SCHEMA_VERSION } from "../../indexer/schema/index.ts";
import type { Settlement, SlotEvent } from "../../indexer/schema/index.ts";
import { assertRun, stateOf } from "./assert.ts";
import type { Readings } from "./assert.ts";
import { FIXTURE_GAS, FIXTURE_PARAMS, fixtureObservations, fixturePool } from "./fixture.ts";
import { spotPriceX96, toBig } from "./math.ts";
import { record, summarise } from "./record.ts";
import { Simulation, readingsFrom } from "./simulate.ts";
import { runSimulatedSoak } from "./simulated-soak.ts";
import { DEFAULT_SOAK, runSoak, soakPlan } from "./soak.ts";
import { validate } from "./validate.ts";

const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");

function readFixture(name: string): SlotEvent[] {
  return validate(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")));
}

function settlements(events: readonly SlotEvent[]): Settlement[] {
  return [...stateOf(events).settlements.values()];
}

test("hx5: the recorded run conforms to the frozen IX-2 schema", () => {
  for (const name of ["run", "settled", "rolled", "evicted", "rolled-back"]) {
    const events = readFixture(name);
    assert.ok(events.length > 0, `${name} is empty`);
    assert.equal(events[0]?.schemaVersion, SCHEMA_VERSION);
  }
});

test("hx5: the fixtures cover a settled, a rolled, an evicted and a rolled-back window", () => {
  const states = new Set<string>();
  for (const event of readFixture("run")) if (event.kind === "window") states.add(event.window.state);
  assert.ok(states.has("settled"), "no settled window");
  assert.ok(states.has("evicted"), "no evicted window");
  assert.ok(states.has("rolled_back"), "no rolled-back window");

  const rolled = readFixture("rolled");
  const rolledOrders = [...stateOf(rolled).orders.values()].filter((order) => order.rolledCount > 0);
  assert.ok(rolledOrders.length > 0, "the rolled fixture has no rolled order");
});

test("hx2: the happy-path fixture settles eight orders in one cross-layer transaction", () => {
  const events = readFixture("settled");
  const settled = settlements(events).filter((settlement) => settlement.outcome === "settled");
  assert.equal(settled.length, 1, "A.6 asks for exactly one cross-layer transaction");
  assert.equal(settled[0]?.filledOrderIds.length, 8);
  assert.equal(summarise(events).get("fills_per_settlement"), 8);
});

test("fl7: an evicted settlement has no L1 receipt and spent no gas", () => {
  const evicted = settlements(readFixture("evicted")).filter((s) => s.outcome === "evicted");
  assert.ok(evicted.length > 0, "the evicted fixture has no evicted settlement");
  for (const settlement of evicted) {
    assert.equal(settlement.l1Receipt, null);
    assert.equal(settlement.l1GasSpent, false);
    assert.equal(settlement.result, null);
  }
  // And the orders are all back where they were, open and intact.
  const orders = [...stateOf(readFixture("evicted")).orders.values()];
  assert.ok(orders.length > 0);
  for (const order of orders) {
    assert.equal(order.state, "open");
    assert.equal(order.fill, null);
  }
});

test("sv4: the postBatch skip is a rollback with L1 gas spent, not an eviction", () => {
  const rolledBack = settlements(readFixture("rolled-back")).filter((s) => s.outcome === "rolled_back");
  assert.ok(rolledBack.length > 0);
  for (const settlement of rolledBack) {
    assert.equal(settlement.rollbackCause, "postbatch_skip");
    assert.equal(settlement.l1GasSpent, true, "the batch landed without the entry: the gas was spent");
    assert.notEqual(settlement.l1Receipt, null);
  }
  // The fills were undone.
  for (const order of stateOf(readFixture("rolled-back")).orders.values()) {
    assert.equal(order.state, "open");
    assert.equal(order.fill, null);
  }
});

test("ix2: recording is deterministic — the same observations give the same stream", () => {
  const observations = fixtureObservations();
  const first = record(observations).events;
  const second = record(observations).events;
  assert.deepEqual(first, second);
  // And it is the fixture on disk, so a committed run is never stale.
  assert.deepEqual(first, readFixture("run"));
});

test("§10: gas per fill is below the direct-L1 counterfactual", () => {
  const settled = settlements(readFixture("settled")).find((s) => s.amortisation !== null);
  const amortisation = settled?.amortisation;
  assert.ok(amortisation != null, "the settled fixture carries no amortisation");
  assert.equal(amortisation.fills, 8);
  const perFill = toBig(amortisation.gasPerFillWei ?? "0");
  const counterfactualPerFill = toBig(amortisation.counterfactualGasCostWei) / BigInt(amortisation.fills);
  assert.ok(perFill < counterfactualPerFill, `${perFill} is not below ${counterfactualPerFill}`);
  assert.ok(toBig(amortisation.savingsWei) > 0n);
});

test("a6: the assertions pass over a run the oracle agrees with", () => {
  const pool = fixturePool(3000n);
  const simulation = new Simulation({
    profile: "full",
    params: FIXTURE_PARAMS,
    pool,
    startUnix: 1_788_000_000,
    startL1Block: 1_000,
    startL2Block: 1,
    windowSlots: 1,
    gas: FIXTURE_GAS,
  });
  const price = spotPriceX96(pool.sqrtPriceX96);
  for (let i = 0; i < 4; i += 1) {
    const sellsA = i % 2 === 0;
    const sellAmount = sellsA ? 2n * 10n ** 18n : 6000n * 10n ** 18n;
    const netIn = sellAmount - sellAmount / 10_000n;
    const atPrice = sellsA ? (netIn * price) >> 96n : (netIn << 96n) / price;
    simulation.place(
      `0x${(i + 1).toString(16).padStart(40, "0")}`,
      sellsA ? "SELL_A_FOR_B" : "SELL_B_FOR_A",
      sellAmount,
      (atPrice * 9_960n) / 10_000n,
    );
    simulation.block();
  }
  simulation.settle();

  const events = validate(record(simulation.observations).events);
  const readings = readingsFrom(
    simulation,
    FIXTURE_PARAMS,
    { mode: "happy", fillsPerSettlement: 4, settlements: 1 },
    simulation.legInputs,
  ) as unknown as Readings;

  const report = assertRun(events, readings);
  assert.equal(report.failures, 0, report.lines.join("\n"));
});

test("a6: the assertions fail when a fill is below its limit", () => {
  // A run the chain could not have produced: one order's limit raised above
  // what it was filled at. If the suite passed this, it would pass a settler
  // that ignored CT-10.
  const events = readFixture("settled").map((event) => {
    if (event.kind !== "order" || event.order.fill === null) return event;
    return {
      ...event,
      order: { ...event.order, minBuyAmount: (toBig(event.order.fill.amountOut) + 1n).toString(10) },
    };
  }) as SlotEvent[];

  const readings: Readings = {
    profile: "full",
    params: {
      feeMode: "bps",
      feeBps: "1",
      feeFixedA: "0",
      feeFixedB: "0",
      routeFeeModel: "absorb",
      routeFeeWei: "0",
      assetAIsNative: "true",
    },
    poolFee: "500",
    mirror: { sqrtPriceX96: "1", liquidity: "1", tick: 0 },
    poolL1: { sqrtPriceX96: "1", liquidity: "1", tick: 0 },
    escrow: [],
    balances: [],
    openOrders: [],
    expect: { mode: "matrix" },
  };
  const report = assertRun(events, readings);
  assert.ok(report.failures > 0, "a fill below its limit went unnoticed");
  assert.ok(report.lines.some((line) => line.includes("CT-10")), report.lines.join("\n"));
});

test("ct13: the assertions fail when the escrow ledger does not balance", () => {
  const events = readFixture("settled");
  const readings: Readings = {
    profile: "full",
    params: {
      feeMode: "bps",
      feeBps: "1",
      feeFixedA: "0",
      feeFixedB: "0",
      routeFeeModel: "absorb",
      routeFeeWei: "0",
      assetAIsNative: "true",
    },
    poolFee: "500",
    mirror: { sqrtPriceX96: "1", liquidity: "1", tick: 0 },
    poolL1: { sqrtPriceX96: "1", liquidity: "1", tick: 0 },
    // One wei short of balancing — the invariant is asserted to the wei.
    escrow: [
      {
        asset: "0x0000000000000000000000000000000000000000",
        escrowed: "0",
        feesAccrued: "0",
        dustAccrued: "0",
        credited: "100",
        deposits: "101",
        released: "0",
        withdrawn: "0",
        drift: "0",
      },
    ],
    balances: [],
    openOrders: [],
    expect: { mode: "matrix" },
  };
  const report = assertRun(events, readings);
  assert.ok(report.failures > 0, "a one-wei escrow drift went unnoticed");
  assert.ok(report.lines.some((line) => line.includes("CT-13")), report.lines.join("\n"));
});

test("hx4: the soak plan is reproducible from its seed", () => {
  const first = soakPlan({ seed: "1", slots: 20 });
  const second = soakPlan({ seed: "1", slots: 20 });
  const other = soakPlan({ seed: "2", slots: 20 });
  assert.deepEqual(first, second, "the same seed produced a different plan");
  assert.notDeepEqual(first, other, "two seeds produced the same plan");
  assert.equal(first.slots.length, 20);
});

test("hx4: a soak leaves no order stranded and reports roll_rate", () => {
  const plan = soakPlan({ seed: DEFAULT_SOAK.seed.toString(), slots: 40 });
  const simulation = runSoak(plan, {
    params: FIXTURE_PARAMS,
    gas: FIXTURE_GAS,
    liquidity: 2_000_000n * 10n ** 18n,
    poolFee: 500n,
    startUnix: 1_788_000_000,
  });

  const events = validate(record(simulation.observations).events);
  const state = stateOf(events);
  const stranded = [...state.orders.values()].filter(
    (order) => order.state !== "filled" && order.state !== "cancelled" && order.state !== "expired",
  );
  // Orders placed in the last window or two have not had a chance to expire
  // yet; everything older must have reached a terminal state.
  const lastWindow = Math.max(...[...state.windows.values()].map((window) => Number(window.windowId)));
  const old = stranded.filter((order) => Number(order.windowId) < lastWindow - DEFAULT_SOAK.expiresAfter);
  assert.deepEqual(
    old.map((order) => `${order.id}:${order.state}`),
    [],
    "orders older than their expiry are still open",
  );

  const metrics = summarise(events).snapshot();
  assert.ok(state.orders.size > 20, `the soak placed only ${state.orders.size} orders`);
  assert.ok(metrics["roll_rate"] !== undefined, "roll_rate was not reported");
  assert.ok((metrics["fills_per_settlement"] ?? 0) > 0, "the soak settled nothing");
  assert.equal(metrics["escrow_invariant_drift_wei"], 0);
});

test("hx4: the soak reports the amortisation metrics and roll_rate", () => {
  // A.6's third pass condition. The soak is not asked to hold these to a
  // threshold, but a run that never printed them has not met it.
  const plan = soakPlan({ seed: DEFAULT_SOAK.seed.toString(), slots: 40 });
  const simulation = runSoak(plan, {
    params: FIXTURE_PARAMS,
    gas: FIXTURE_GAS,
    liquidity: 2_000_000n * 10n ** 18n,
    poolFee: 500n,
    startUnix: 1_788_000_000,
  });

  const events = validate(record(simulation.observations).events);
  const readings = readingsFrom(
    simulation,
    FIXTURE_PARAMS,
    { mode: "soak", allOrdersTerminal: false },
    simulation.legInputs,
  ) as unknown as Readings;

  const report = assertRun(events, readings);
  for (const metric of ["roll_rate", "fills_per_settlement", "netting_ratio", "gas_per_fill_wei", "counterfactual_l1_gas_wei"]) {
    assert.ok(
      report.lines.some((line) => line.includes(metric)),
      `${metric} was not reported:\n${report.lines.join("\n")}`,
    );
  }
  assert.ok(report.lines.some((line) => line.includes("amortisation:")), report.lines.join("\n"));
});

test("ct13: the soak's escrow ledger balances to the wei", () => {
  const plan = soakPlan({ seed: "7", slots: 40 });
  const simulation = runSoak(plan, {
    params: FIXTURE_PARAMS,
    gas: FIXTURE_GAS,
    liquidity: 2_000_000n * 10n ** 18n,
    poolFee: 500n,
    startUnix: 1_788_000_000,
  });
  for (const { asset, ledger } of simulation.escrowLedgers()) {
    const held = ledger.escrowed + ledger.feesAccrued + ledger.dustAccrued + ledger.credited;
    const net = ledger.deposits - ledger.released - ledger.withdrawn;
    assert.equal(held, net, `${asset} drifted by ${held - net} wei`);
  }
});

test("hx4: the simulated soak reports what §10 asks of the enclave one", () => {
  // Phase 6's `scripts/verify.sh` runs this where no enclave is available, so
  // what it reports has to be exactly what A.6 asks of a soak — and it has to
  // say, in the report itself, that it is a simulation and not a run.
  const report = runSimulatedSoak("1", 30);

  assert.equal(report.tier, "simulated", "a simulated run must never claim to be an enclave one");
  assert.ok(report.orders > 0 && report.settlements > 0, "the soak placed and settled something");
  assert.equal(report.stranded, 0, "HX-4: no order older than its expiry was left open");
  assert.equal(report.limitViolations, 0, "§10: nobody is filled outside their limit");
  assert.equal(report.metrics["escrow_invariant_drift_wei"], 0, "CT-13, to the wei");
  assert.equal(report.metrics["selection_omitted_total"], 0, "EC-4: the audit found no omitted order");
  for (const metric of ["fills_per_settlement", "netting_ratio", "roll_rate", "gas_per_fill_wei"]) {
    assert.ok(report.metrics[metric] !== undefined, `${metric} was not reported`);
  }
});
