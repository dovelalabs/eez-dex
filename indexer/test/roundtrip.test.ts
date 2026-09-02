/**
 * Schema round-trip — RD-2 TS-5, IX-2.
 *
 * Every event type the stream can carry serialises and parses back
 * identically, and everything the gateway serves validates against the frozen
 * schema. This is the contract WP-4's fixture and WP-6's reducer are written
 * against; if it does not hold here it does not hold anywhere.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SCHEMA_VERSION, SLOT_EVENT_KINDS } from "../schema/index.ts";
import type { SlotEvent } from "../schema/index.ts";
import { parseRecordedRun } from "../src/sources/replay.ts";
import { parseSlotEvent, SchemaError, validateSnapshot } from "../src/validate.ts";
import { recordScriptedRun } from "./script.ts";

const RUN = fileURLToPath(new URL("fixtures/run.json", import.meta.url));

test("ts5: every event type round-trips through JSON unchanged", () => {
  const run = parseRecordedRun(JSON.parse(readFileSync(RUN, "utf8")));
  const kinds = new Set(run.events.map((event) => event.kind));

  // The recorded run is only a round-trip test if it carries every kind.
  assert.deepEqual([...kinds].sort(), [...SLOT_EVENT_KINDS].sort());

  for (const event of run.events) {
    const wire = JSON.parse(JSON.stringify(event)) as unknown;
    assert.deepEqual(parseSlotEvent(wire), event);
    assert.deepEqual(JSON.parse(JSON.stringify(parseSlotEvent(wire))), wire);
  }
});

test("ix2: a version this build does not know is refused, not guessed at", () => {
  const event: SlotEvent = {
    schemaVersion: SCHEMA_VERSION,
    seq: 1,
    kind: "slot",
    atUnix: 1_800_000_000,
    l1Block: 21_000_000,
    windowId: "1",
  };
  assert.deepEqual(parseSlotEvent(JSON.parse(JSON.stringify(event))), event);

  assert.throws(
    () => parseSlotEvent({ ...event, schemaVersion: SCHEMA_VERSION + 1 }),
    (error: unknown) => error instanceof SchemaError && /refusing rather than guessing/.test(error.message),
  );
});

test("ix2: a field the schema does not allow is refused with its path", () => {
  assert.throws(
    () => parseSlotEvent({ schemaVersion: 1, seq: 1, kind: "window", atUnix: 0, window: { schemaVersion: 1 } }),
    (error: unknown) => error instanceof SchemaError && error.path.startsWith("event.window"),
  );
  // A.1: quantities wider than a double travel as decimal strings, never numbers.
  assert.throws(
    () =>
      parseSlotEvent({
        schemaVersion: 1,
        seq: 1,
        kind: "l2_block",
        atUnix: 0,
        l2Block: 4,
        windowId: 1,
        blocksRemaining: 2,
      }),
    SchemaError,
  );
});

test("ts5: the snapshot the gateway serves validates against the frozen schema", async () => {
  const { hub } = await recordScriptedRun();
  const wire = JSON.parse(JSON.stringify(hub.snapshot())) as unknown;
  assert.deepEqual(validateSnapshot(wire), []);
});

test("ix3: the amortisation the snapshot totals is the settlements' own", async () => {
  const { hub } = await recordScriptedRun();
  const snapshot = hub.snapshot();
  const settled = snapshot.settlements.filter((settlement) => settlement.amortisation !== null);

  assert.ok(settled.length > 0, "the scripted run settles at least once");
  const cumulative = snapshot.amortisation.cumulative;
  assert.equal(cumulative.settlements, settled.length);
  assert.equal(
    cumulative.fills,
    settled.reduce((total, settlement) => total + (settlement.amortisation?.fills ?? 0), 0),
  );
  assert.equal(
    BigInt(cumulative.savingsWei),
    BigInt(cumulative.counterfactualGasCostWei) - BigInt(cumulative.l1GasCostWei),
  );
});
