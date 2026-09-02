/**
 * The gateway against WP-4's recorded runs — RD-2 IX-1, IX-2, IX-3, HX-5, TS-5.
 *
 * Phase 6, part A item 3. This package was built against a fixture it writes
 * itself (`test/fixtures/run.json`, a scripted live run), which proves the
 * fold and the replay agree with each other but not that either agrees with
 * the harness. These read the **committed HX-5 fixtures** — the recorded runs
 * the scenario produces and the frontend replays — and hold the gateway to
 * them.
 *
 * Where the two disagree the frozen schema decides (`schema/version.ts`): a
 * fixture that does not parse is a failing fixture, never a reason to widen a
 * type here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Settlement, SlotEvent, Window } from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import { createIndexer } from "../src/index.ts";
import type { Snapshot } from "../src/protocol.ts";
import { parseRecordedRun } from "../src/sources/replay.ts";

const FIXTURES = fileURLToPath(new URL("../../scenario/fixtures/", import.meta.url));

/** The four A.4 window outcomes, plus the whole session. */
const RECORDINGS = ["run", "settled", "rolled", "evicted", "rolled-back"] as const;

function events(name: string): readonly SlotEvent[] {
  return parseRecordedRun(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8"))).events;
}

/** Serves one recorded run through the gateway, exactly as `--fixture` does. */
async function serve(name: string): Promise<Snapshot> {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    serve: false,
    profile: "devnet",
    fixture: `${FIXTURES}${name}.json`,
    speed: 0,
  });
  try {
    await indexer.done;
    return await indexer.snapshot();
  } finally {
    await indexer.close();
  }
}

function windowsIn(snapshot: Snapshot): readonly Window[] {
  return snapshot.windows;
}

/** The one settlement in a recording with this outcome. */
function settlementWith(snapshot: Snapshot, outcome: Settlement["outcome"]): Settlement {
  const matching = snapshot.settlements.filter((candidate) => candidate.outcome === outcome);
  assert.equal(matching.length, 1, `expected one ${outcome} settlement, found ${matching.length}`);
  return matching[0]!;
}

test("ix2: every committed HX-5 recording parses under the frozen schema", () => {
  for (const name of RECORDINGS) {
    const recorded = events(name);
    assert.ok(recorded.length > 0, `${name}.json is empty`);
    for (const event of recorded) {
      assert.equal(event.schemaVersion, SCHEMA_VERSION, `${name}.json speaks another schema version`);
    }
  }
});

test("ix1: the gateway re-issues the recorded sequence as the identity", async () => {
  // "Replay equals live" is only meaningful if a well-formed recording comes
  // out as it went in: the hub re-issues `seq` from its own start, and for the
  // harness's recordings that re-issue changes nothing (TS-5).
  for (const name of RECORDINGS) {
    const recorded = events(name);
    const indexer = await createIndexer({
      l1Rpc: "",
      l2Rpc: "",
      windowBook: "",
      port: 0,
      serve: false,
      profile: "devnet",
      fixture: `${FIXTURES}${name}.json`,
      speed: 0,
    });
    await indexer.done;
    assert.deepEqual(indexer.events(0), recorded, `${name}.json did not survive the gateway`);
    await indexer.close();
  }
});

test("hx5: the happy path settles eight fills in one cross-layer transaction", async () => {
  const snapshot = await serve("settled");
  assert.equal(windowsIn(snapshot).filter((window) => window.state === "settled").length, 1);

  const settlement = settlementWith(snapshot, "settled");
  assert.equal(settlement.filledOrderIds.length, 8, "A.6: fills_per_settlement == 8");
  assert.equal(
    new Set(snapshot.orders.filter((order) => order.state === "filled").map((order) => order.owner)).size,
    8,
    "A.6: eight accounts, not one account eight times",
  );

  // IX-3, computed once and carried on the settlement (never recomputed here).
  const amortisation = snapshot.amortisation.perSettlement.find((entry) => entry.settlementId === settlement.id);
  assert.ok(amortisation, "the settled window carries an amortisation");
  assert.equal(amortisation.fills, 8);
  assert.ok(BigInt(amortisation.gasPerFillWei ?? "0") > 0n);
  assert.ok(
    BigInt(amortisation.gasPerFillWei ?? "0") < BigInt(amortisation.counterfactualGasCostWei) / 8n,
    "§10: gas per fill is below the direct-L1 counterfactual",
  );
});

test("hx5: the drifted window fills the orders inside their limit and rolls the rest", async () => {
  const snapshot = await serve("rolled");
  const settlement = settlementWith(snapshot, "settled");
  const filled = snapshot.orders.filter((order) => order.state === "filled");
  const open = snapshot.orders.filter((order) => order.state === "open");

  assert.ok(filled.length > 0, "the orders inside their limit filled");
  assert.ok(open.length > 0, "the orders outside it did not");
  assert.deepEqual(
    new Set(filled.map((order) => order.id)),
    new Set(settlement.filledOrderIds),
    "the settlement names exactly the orders that filled",
  );
  // FL-8: an unselected order is still open, and it has rolled once — which
  // is the number `roll_rate` and the frontend's drift panel are read from.
  assert.ok(
    open.every((order) => order.rolledCount > 0),
    "FL-8: a rolled order stays open and counts its roll",
  );
  assert.ok(
    filled.every((order) => order.fill !== null && BigInt(order.fill.amountOut) >= BigInt(order.minBuyAmount)),
    "§10: nobody is filled outside their limit",
  );
});

test("hx5: the poison eviction costs no L1 gas and leaves every order open", async () => {
  const snapshot = await serve("evicted");
  const settlement = settlementWith(snapshot, "evicted");
  // A.4: an evicted window returns to `open` with its orders intact — the
  // eviction is the settlement's outcome, never the window's resting state.
  assert.ok(
    windowsIn(snapshot).every((window) => window.state === "open"),
    "A.4: the window went back to open",
  );
  assert.equal(settlement.l1GasSpent, false, "§10: a free failure");
  assert.equal(settlement.l1Receipt, null, "nothing landed on L1");
  assert.equal(settlement.filledOrderIds.length, 0, "no fills");
  assert.ok(
    snapshot.orders.every((order) => order.state === "open"),
    "every order is still open",
  );
  assert.equal(
    snapshot.amortisation.perSettlement.filter((entry) => entry.settlementId === settlement.id).length,
    0,
    "IX-3: an eviction amortises nothing, so it carries no counter",
  );
});

test("hx5: the postBatch skip rolls the window back and records the gas it did spend", async () => {
  const snapshot = await serve("rolled-back");
  const settlement = settlementWith(snapshot, "rolled_back");
  assert.equal(settlement.rollbackCause, "postbatch_skip", "A.4: a rollback names its cause");
  assert.equal(settlement.l1GasSpent, true, "the one rollback that is not free (SV-4)");

  // A.4 again: the fills are undone, so the window is open with its orders
  // intact and the run ends with nothing filled.
  assert.ok(
    windowsIn(snapshot).every((window) => window.state === "open"),
    "the rolled-back window returned to open",
  );
  assert.ok(
    snapshot.orders.every((order) => order.state === "open"),
    "the fills were undone",
  );
});

test("ix3: a rolled-back settlement contributes its gas and not its fills", async () => {
  const snapshot = await serve("run");
  const rolledBack = settlementWith(snapshot, "rolled_back");
  const entry = snapshot.amortisation.perSettlement.find((a) => a.settlementId === rolledBack.id);
  assert.ok(entry, "the rollback spent L1 gas, so it carries its own figures");

  const cumulative = snapshot.amortisation.cumulative;
  const standing = snapshot.amortisation.perSettlement.filter((a) =>
    snapshot.settlements.some((s) => s.id === a.settlementId && s.outcome === "settled"),
  );

  // SV-4: the fills were undone, so the counter must not still claim them —
  // but the gas was spent, so it must still be paid for (FE-6, IX-3).
  assert.equal(
    cumulative.fills,
    standing.reduce((total, a) => total + a.fills, 0),
    "the counter counts only the fills that stand",
  );
  assert.equal(
    BigInt(cumulative.l1GasCostWei),
    snapshot.amortisation.perSettlement.reduce((total, a) => total + BigInt(a.l1GasCostWei), 0n),
    "every wei of L1 gas is counted, including a rollback's",
  );
  assert.ok(
    BigInt(cumulative.l1GasCostWei) > standing.reduce((total, a) => total + BigInt(a.l1GasCostWei), 0n),
    "this recording's rollback did spend gas, or the assertion above proves nothing",
  );
});

test("hx5: the whole session folds to one consistent snapshot", async () => {
  const snapshot = await serve("run");
  const outcomes = new Set(snapshot.settlements.map((settlement) => settlement.outcome));
  for (const outcome of ["settled", "evicted", "rolled_back"]) {
    assert.ok(outcomes.has(outcome as Settlement["outcome"]), `the session covers a ${outcome} settlement`);
  }
  // The window that was evicted and then rolled back is the same window that
  // finally settles: an evicted or rolled-back window re-forms (A.4).
  const repaired = snapshot.settlements.filter((settlement) => settlement.windowId === "2");
  assert.deepEqual(
    repaired.map((settlement) => settlement.outcome),
    ["evicted", "rolled_back", "settled"],
    "A.4: evicted, rolled back, then repaired",
  );

  // Every settlement names a window the snapshot holds, and every filled order
  // is claimed by exactly one settlement (IX-2's shape, over real data).
  const windowIds = new Set(windowsIn(snapshot).map((window) => window.windowId));
  const claimed = new Map<string, string>();
  for (const settlement of snapshot.settlements) {
    assert.ok(windowIds.has(settlement.windowId), `settlement for unknown window ${settlement.windowId}`);
    if (settlement.outcome !== "settled") continue;
    for (const orderId of settlement.filledOrderIds) {
      assert.equal(claimed.get(orderId), undefined, `order ${orderId} filled by two settlements`);
      claimed.set(orderId, settlement.id);
    }
  }
  for (const order of snapshot.orders) {
    if (order.state === "filled") assert.ok(claimed.has(order.id), `filled order ${order.id} has no settlement`);
  }

  assert.equal(
    snapshot.amortisation.cumulative.fills,
    [...claimed.keys()].length,
    "IX-3: the cumulative counter counts the fills the stream reported",
  );
});
