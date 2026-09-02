/**
 * The two doors — RD-2 IX-1, FE-10, TS-5.
 *
 * A JSON-over-WebSocket stream and a REST snapshot, served by the same hub, on
 * a real socket. The WebSocket is this package's own hundred lines of RFC 6455
 * (`src/server/ws.ts`), so it is tested against Node's own client rather than
 * against itself.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { SCHEMA_VERSION } from "../schema/index.ts";
import type { SlotEvent } from "../schema/index.ts";
import { createIndexer } from "../src/index.ts";
import { EventHub } from "../src/hub.ts";
import { loading } from "../src/protocol.ts";
import type { ServerFrame } from "../src/protocol.ts";
import { serve } from "../src/server/http.ts";
import { validateSnapshot } from "../src/validate.ts";

const RUN = fileURLToPath(new URL("fixtures/run.json", import.meta.url));

function slot(seq: number): SlotEvent {
  return { schemaVersion: SCHEMA_VERSION, seq, kind: "slot", atUnix: 1_800_000_000 + seq, l1Block: seq, windowId: "1" };
}

/**
 * Collects frames until `count` of `until` have arrived, then closes.
 *
 * `status` frames are part of the stream — a client is told when the activity
 * or an upstream changes — so a test that wants events counts events.
 */
function frames(url: string, count: number, until: ServerFrame["type"] = "snapshot"): Promise<ServerFrame[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const collected: ServerFrame[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`only ${collected.length} frames arrived, waiting for ${count} of ${until}`));
    }, 5_000);

    socket.addEventListener("message", (message) => {
      collected.push(JSON.parse(String(message.data)) as ServerFrame);
      if (collected.filter((frame) => frame.type === until).length < count) return;
      clearTimeout(timer);
      socket.close();
      resolve(collected);
    });
    socket.addEventListener("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("socket error"));
    });
  });
}

test("ix1: a client is sent a snapshot first, then the stream", async () => {
  const hub = new EventHub({ mode: "live", profile: "devnet", sources: [loading("l2")] });
  const gateway = await serve({ hub, profile: "devnet", port: 0 });
  after(() => gateway.close());

  const collecting = frames(`ws://127.0.0.1:${gateway.port}/stream`, 2, "event");
  // Emitted after the client connects, so these can only have arrived live.
  await new Promise((resolve) => setTimeout(resolve, 50));
  hub.emit(slot(1));
  hub.emit(slot(2));

  const collected = await collecting;
  assert.equal(collected[0]?.type, "snapshot", "a client is level before it is streamed to");
  const events = collected.filter((frame) => frame.type === "event");
  assert.deepEqual(
    events.map((frame) => (frame.type === "event" ? frame.event.seq : null)),
    [1, 2],
  );
});

test("ix1: a late joiner's snapshot is level with the stream it joins", async () => {
  const hub = new EventHub({ mode: "live", profile: "devnet", sources: [loading("l2")] });
  const gateway = await serve({ hub, profile: "devnet", port: 0 });
  after(() => gateway.close());

  hub.emit(slot(1));
  hub.emit(slot(2));

  const [first] = await frames(`ws://127.0.0.1:${gateway.port}/stream`, 1);
  assert.equal(first?.type, "snapshot");
  assert.equal(first?.type === "snapshot" ? first.snapshot.seq : null, 2);
  assert.equal(first?.type === "snapshot" ? first.snapshot.l1Block : null, 2);
});

test("ix1: the REST snapshot serves the same state, and validates", async () => {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "testnet",
    fixture: RUN,
    speed: 0,
  });
  after(() => indexer.close());
  await indexer.done;

  const response = await fetch(`http://127.0.0.1:${indexer.port}/snapshot`);
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as Record<string, unknown>;

  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot["schemaVersion"], SCHEMA_VERSION);
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(await indexer.snapshot())));

  // FE-10's scrubber and a reconnect both ask by sequence number.
  const events = (await (await fetch(`http://127.0.0.1:${indexer.port}/events?since=50`)).json()) as {
    events: SlotEvent[];
  };
  assert.ok(events.events.length > 0);
  assert.ok(events.events.every((event) => event.seq > 50));
});

test("ix1: health states the mode, the activity and every upstream", async () => {
  const indexer = await createIndexer({
    l1Rpc: "",
    l2Rpc: "",
    windowBook: "",
    port: 0,
    profile: "testnet",
    fixture: RUN,
    speed: 0,
  });
  after(() => indexer.close());
  await indexer.done;

  const health = (await (await fetch(`http://127.0.0.1:${indexer.port}/health`)).json()) as {
    status: { mode: string; activity: string; sources: { source: string; state: string }[] };
  };
  assert.equal(health.status.mode, "replay");
  assert.equal(health.status.activity, "ended");
  assert.equal(health.status.sources.length, 1);
  assert.equal(health.status.sources[0]?.source, "fixture");
  assert.equal(health.status.sources[0]?.state, "ok");
});

test("ix1: an unknown route is a 404, not a guess", async () => {
  const hub = new EventHub({ mode: "live", profile: "devnet", sources: [loading("l2")] });
  const gateway = await serve({ hub, profile: "devnet", port: 0 });
  after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${gateway.port}/nope`);
  assert.equal(response.status, 404);
});
