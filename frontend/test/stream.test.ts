/**
 * The sources and what they will read — RD-2 IX-2, FE-10, FE-12.
 *
 * The version check is the load-bearing one: a build that reads a version it
 * does not know **refuses the stream rather than guessing**, because a
 * recording may be months older than the app replaying it (`schema/version`).
 * The rest is the replay source doing what the gateway's does — the same
 * frames, in the same order, at a clock.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

import { readConfig } from "../src/config.ts";
import { initialState, reduce, type Action, type AppState } from "../src/state/app.ts";
import { isSlotEvent, parseFrame, parseRecording, UnreadableStream } from "../src/stream/frames.ts";
import { ReplaySource } from "../src/stream/replay.ts";
import { snapshotUrl, streamUrl } from "../src/stream/socket.ts";

const FIXTURE = new URL("../../scenario/fixtures/settled.json", import.meta.url);

function recording(): unknown {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("ix2: a frame of the version this build speaks is read", () => {
  const events = parseRecording(recording());
  const frame = parseFrame(JSON.stringify({ type: "event", event: events[0] }));
  assert.equal(frame.type, "event");
  assert.ok(isSlotEvent(events[0]));
});

test("ix2: a frame of a version this build does not speak is refused, not guessed at", () => {
  const events = parseRecording(recording());
  const future = { ...events[0], schemaVersion: SCHEMA_VERSION + 1 };

  assert.throws(
    () => parseFrame(JSON.stringify({ type: "event", event: future })),
    (error: unknown) => error instanceof UnreadableStream && /schema version/.test(error.message),
  );
  assert.throws(() => parseRecording([future]), UnreadableStream);
  assert.throws(() => parseFrame("not json"), UnreadableStream);
  assert.throws(() => parseFrame(JSON.stringify({ type: "hello" })), UnreadableStream);
});

test("ix2: an event of an unknown kind is refused rather than folded as nothing", () => {
  assert.throws(
    () => parseRecording([{ schemaVersion: SCHEMA_VERSION, seq: 1, atUnix: 1, kind: "rumour" }]),
    UnreadableStream,
  );
});

test("hx5: a recording is read as a bare log or as the gateway's document", () => {
  const events = parseRecording(recording());
  assert.ok(events.length > 20);
  assert.deepEqual(parseRecording({ schemaVersion: SCHEMA_VERSION, events }), events);
  assert.throws(() => parseRecording({ nope: true }), UnreadableStream);
});

test("ix1: the socket and snapshot URLs are the gateway's two doors", () => {
  assert.equal(streamUrl("http://127.0.0.1:8080"), "ws://127.0.0.1:8080/stream");
  assert.equal(streamUrl("https://gateway.example/anything?x=1"), "wss://gateway.example/stream");
  assert.equal(snapshotUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/snapshot");
});

/** Drives a replay to its end and returns the state it produced. */
async function play(url: string, speed = 0): Promise<{ state: AppState; actions: readonly Action[] }> {
  const config = readConfig({}, "?mode=replay");
  let state = initialState(config);
  const actions: Action[] = [];
  let ended: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    ended = resolve;
  });

  const source = new ReplaySource({
    fixtureUrl: url,
    speed,
    dispatch: (action) => {
      actions.push(action);
      state = reduce(state, action);
      if (action.type === "replay" && action.replay.ended) ended();
      if (action.type === "connection" && action.state === "failed") ended();
    },
    // Only the one recording exists, so a request for any other 404s — which
    // is what the app has to render honestly.
    fetchImpl: (async (target: string) =>
      target === "/fixtures/settled.json"
        ? { ok: true, json: async () => JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown }
        : { ok: false, status: 404, json: async () => ({}) }) as unknown as typeof fetch,
  });

  source.start();
  await done;
  source.stop();
  return { state, actions };
}

test("fe10: a recorded run plays through the same frames the gateway would send", async () => {
  const { state, actions } = await play("/fixtures/settled.json");

  const recorded = parseRecording(recording());
  const emitted = actions.filter((action) => action.type === "frame").map((action) => action.frame);
  assert.equal(emitted.length, recorded.length, "every recorded event is emitted, and nothing else");
  assert.deepEqual(state.log, recorded, "in the order it was recorded in");
  assert.equal(state.connection, "open");
  assert.equal(state.replay?.total, recorded.length);
  assert.equal(state.replay?.position, recorded.length);
  assert.equal(state.replay?.ended, true);
});

test("fe10: a recording that is not there is a stated failure, not an empty chain", async () => {
  const { state } = await play("/fixtures/missing.json");
  assert.equal(state.connection, "failed");
  assert.match(state.connectionDetail ?? "", /no recording/);
  assert.equal(state.chain.events, 0);
});

test("fe10: the scrubber can seek forward past what has played", async () => {
  const config = readConfig({}, "?mode=replay");
  let state = initialState(config);
  const source = new ReplaySource({
    fixtureUrl: "/fixtures/settled.json",
    // Real time: nothing plays on its own inside this test's lifetime.
    speed: 1,
    dispatch: (action) => {
      state = reduce(state, action);
    },
    fetchImpl: (async () => ({ ok: true, json: async () => JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown })) as unknown as typeof fetch,
  });

  source.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const played = state.log.length;

  source.seek(played + 5);
  assert.equal(state.log.length, played + 5, "seeking forward fast-forwards the recording to that point");
  assert.equal(state.scrubbedTo, played + 5);

  source.seek(null);
  assert.equal(state.scrubbedTo, null);
  source.stop();
});
