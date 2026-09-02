/**
 * Replay equals live — RD-2 TS-5, IX-1, FE-10.
 *
 * The requirement is exact: *the frontend cannot tell a replay from a live
 * run.* These tests hold the gateway to it in the two ways it can be held.
 *
 * First, structurally: a recorded run served by the replay source produces the
 * same events, the same snapshot and the same frames as the live source that
 * recorded it. Second, modulo timestamps: the same script run at a different
 * wall clock produces the same stream with every timestamp shifted and nothing
 * else changed — which is what makes a recording from last month replay today
 * without the reducer noticing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { SlotEvent } from "../schema/index.ts";
import { fastClock } from "../src/clock.ts";
import { EventHub } from "../src/hub.ts";
import { loading } from "../src/protocol.ts";
import { ReplaySource, parseRecordedRun } from "../src/sources/replay.ts";
import { recordScriptedRun } from "./script.ts";

const RUN = fileURLToPath(new URL("fixtures/run.json", import.meta.url));

/** Serves a recorded run through the hub, exactly as the gateway does. */
async function replay(events: readonly SlotEvent[], speed = 0): Promise<EventHub> {
  const hub = new EventHub({ mode: "replay", profile: "testnet", now: () => 0, sources: [loading("fixture")] });
  const source = new ReplaySource({ schemaVersion: 1, events }, hub, { speed, clock: fastClock() });
  await source.run();
  return hub;
}

function collect(hub: EventHub): readonly SlotEvent[] {
  return hub.events(0);
}

test("ts5: a replay of a live run emits exactly what the live run emitted", async () => {
  const live = await recordScriptedRun();
  const replayed = await replay(live.events);

  assert.deepEqual(collect(replayed), live.events);
  // And the same fold over the same events is the same snapshot, so a client
  // that connects to a replay sees the world the live client saw.
  assert.deepEqual(replayed.snapshot().windows, live.hub.snapshot().windows);
  assert.deepEqual(replayed.snapshot().orders, live.hub.snapshot().orders);
  assert.deepEqual(replayed.snapshot().settlements, live.hub.snapshot().settlements);
  assert.deepEqual(replayed.snapshot().amortisation, live.hub.snapshot().amortisation);
});

test("ts5: the committed fixture is that same stream, and still is", async () => {
  const fixture = parseRecordedRun(JSON.parse(readFileSync(RUN, "utf8")));
  const live = await recordScriptedRun();
  assert.deepEqual(
    fixture.events,
    live.events,
    "test/fixtures/run.json has drifted from the live path; regenerate it with `node test/fixtures/build.ts`",
  );
});

test("ts5: fixture-driven and live-driven streams are identical modulo timestamps", async () => {
  const live = await recordScriptedRun();
  const shifted = await recordScriptedRun(1_900_000_000);
  const offset = 1_900_000_000 - 1_800_000_000;

  assert.equal(shifted.events.length, live.events.length);
  for (const [index, event] of live.events.entries()) {
    const other = shifted.events[index]!;
    // Timestamps move by exactly the shift; nothing else moves at all.
    assert.equal(other.atUnix, event.atUnix + offset, `event ${index} (${event.kind}) moved by the wrong amount`);
    assert.deepEqual(strip(other), strip(event), `event ${index} (${event.kind}) differs beyond its timestamps`);
  }
});

/** Everything about an event except when it happened. */
function strip(event: SlotEvent): unknown {
  return JSON.parse(
    JSON.stringify(event, (key, value: unknown) =>
      key.endsWith("Unix") || key === "mirrorTimestamp" || key === "deadline" ? 0 : value,
    ),
  );
}

test("fe10: a replay reports its position, and that it ended", async () => {
  const live = await recordScriptedRun();
  const hub = new EventHub({ mode: "replay", profile: "testnet", now: () => 0, sources: [loading("fixture")] });
  const source = new ReplaySource({ schemaVersion: 1, events: live.events }, hub, { speed: 0, clock: fastClock() });

  const positions: number[] = [];
  hub.subscribe((frame) => {
    if (frame.type === "status" && frame.status.replay !== null) positions.push(frame.status.replay.position);
  });
  await source.run();

  const status = hub.status();
  assert.equal(status.mode, "replay");
  assert.equal(status.activity, "ended");
  assert.equal(status.replay?.total, live.events.length);
  assert.equal(status.replay?.position, live.events.length);
  assert.ok(positions.length > 1, "the scrubber is told where the replay has got to");
});

test("fe10: replay is paced by the recording's own clock, sped up on request", async () => {
  const events: SlotEvent[] = [
    { schemaVersion: 1, seq: 1, kind: "slot", atUnix: 1_000, l1Block: 1, windowId: "1" },
    { schemaVersion: 1, seq: 2, kind: "slot", atUnix: 1_012, l1Block: 2, windowId: "1" },
    { schemaVersion: 1, seq: 3, kind: "slot", atUnix: 1_024, l1Block: 3, windowId: "1" },
  ];

  const real = fastClock(0);
  const hub = new EventHub({ mode: "replay", profile: "testnet", now: () => 0, sources: [loading("fixture")] });
  await new ReplaySource({ schemaVersion: 1, events }, hub, { speed: 1, clock: real }).run();
  assert.equal(real.now(), 24, "two 12 s slots at 1x take 24 s");

  const fast = fastClock(0);
  const quick = new EventHub({ mode: "replay", profile: "testnet", now: () => 0, sources: [loading("fixture")] });
  await new ReplaySource({ schemaVersion: 1, events }, quick, { speed: 4, clock: fast }).run();
  assert.equal(fast.now(), 6, "the same run at 4x takes a quarter of the time");
  assert.deepEqual(collect(quick), collect(hub), "and emits exactly the same events either way");
});

test("ix1: a fixture the schema refuses is not replayed at all", () => {
  assert.throws(() => parseRecordedRun({ events: [{ kind: "slot" }] }));
  assert.throws(() => parseRecordedRun("not a run"));
});
