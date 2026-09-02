/**
 * The read-side gateway — RD-2 WP-5, IX-1, IX-2, IX-3.
 *
 * One small read-only service that folds three upstream views — L2 RPC
 * (`WindowBook`'s events and the safe head), L1 RPC (settlement receipts, the
 * pool's live state) and the settler's projection — into a single
 * JSON-over-WebSocket stream of {@link SlotEvent} plus a REST snapshot, and
 * that serves a recorded run (HX-5) through the same stream at real or
 * accelerated clock.
 *
 * **It holds no keys and exposes no write path.** Every chain call it makes is
 * an `eth_` read. The single exception is the demo director's control proxy,
 * which exists on the devnet profile and nowhere else — not disabled
 * elsewhere, absent (IX-1, FE-9).
 *
 * The parts:
 *
 * | Module | What it is |
 * |---|---|
 * | `hub.ts` | the one stream: sequence, snapshot fold, fan-out |
 * | `sources/fold.ts` | the pure fold from observations to events |
 * | `sources/live.ts` | the three upstream reads |
 * | `sources/replay.ts` | a recorded run, at a clock |
 * | `amortisation.ts` | IX-3, computed once so every view agrees |
 * | `validate.ts` | the frozen schema, enforced at the boundary |
 * | `server/` | the socket, the REST routes, the devnet director |
 */

import { SCHEMA_VERSION } from "../schema/index.ts";
import type { SlotEvent } from "../schema/index.ts";
import { EventHub } from "./hub.ts";
import { absent, loading, type IndexerProfile, type Snapshot, type StreamMode, type StreamStatus } from "./protocol.ts";
import { httpRpc } from "./chain/rpc.ts";
import { DEFAULT_DIRECTOR_COMMAND, DEFAULT_POLL_INTERVAL_MS, type IndexerOptions } from "./options.ts";
import { serve, type GatewayServer } from "./server/http.ts";
import { LiveSource } from "./sources/live.ts";
import { loadRecordedRun, ReplaySource } from "./sources/replay.ts";
import { systemClock } from "./clock.ts";

export * from "../schema/index.ts";
export * from "./protocol.ts";
export * from "./options.ts";
export { EventHub } from "./hub.ts";
export { amortisationFor } from "./amortisation.ts";
export { fastClock, systemClock, type Clock } from "./clock.ts";
export { emptyState, reduce, toSnapshot, type StreamState } from "./reduce.ts";
export { LiveSource } from "./sources/live.ts";
export { foldSample, initialModel, type ChainSample, type LiveModel } from "./sources/fold.ts";
export { loadRecordedRun, parseRecordedRun, ReplaySource, type RecordedRun } from "./sources/replay.ts";
export { parseSettlerView, readSettlerView, type SettlerView } from "./settler.ts";
export {
  isSlotEvent,
  parseMirrorSnapshot,
  parseOrder,
  parseSettlement,
  parseSlotEvent,
  parseWindow,
  SchemaError,
  validateSnapshot,
} from "./validate.ts";

/** The running gateway. */
export interface Indexer {
  /** The IX-2 schema version this instance speaks. */
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Live chain or recorded run — one code path serves both (IX-1). */
  readonly mode: StreamMode;
  readonly profile: IndexerProfile;
  /** The port the REST and WebSocket surface is bound to, or null. */
  readonly port: number | null;
  /** The routes this profile exposes. Off devnet, none of them is a director. */
  readonly routes: readonly string[];
  /**
   * The ordered event stream, live or replayed. It starts with everything the
   * gateway still holds after `since`, then continues live.
   */
  stream(since?: number): AsyncIterable<SlotEvent>;
  /** The REST snapshot: windows, orders, settlements, the mirror, IX-3. */
  snapshot(): Promise<Snapshot>;
  /** The stream's own state: mode, activity, and every upstream's health. */
  status(): StreamStatus;
  /** Events after `since`, for a reconnect or FE-10's scrubber. */
  events(since?: number): readonly SlotEvent[];
  /** Resolves when a replay reaches the end of its recording, or on close. */
  readonly done: Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts the gateway.
 *
 * With `fixture` set it replays a recorded run; without, it reads the chains.
 * Both push at the same hub, and everything downstream of that — the fold, the
 * snapshot, the frames, the socket — is the same code.
 */
export async function createIndexer(options: IndexerOptions): Promise<Indexer> {
  const profile = options.profile ?? "devnet";
  const mode: StreamMode = options.fixture === undefined ? "live" : "replay";
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const hub = new EventHub({
    mode,
    profile,
    now,
    sources:
      mode === "replay"
        ? [loading("fixture")]
        : [
            loading("l2"),
            options.l1Rpc === ""
              ? absent("l1", "no L1 endpoint configured: L1 receipts and IX-3 are not available")
              : loading("l1"),
            options.settlerUrl === undefined
              ? absent(
                  "settler",
                  "no settler configured: the price band, evictions and rollbacks are not observable from L2 logs alone",
                )
              : loading("settler"),
          ],
  });

  let stopSource: () => void = () => {};
  let closed: () => void = () => {};
  let done: Promise<void>;

  if (options.fixture !== undefined) {
    const run = await loadRecordedRun(options.fixture);
    const replay = new ReplaySource(run, hub, {
      speed: options.speed ?? 1,
      clock: systemClock,
    });
    stopSource = () => replay.stop();
    done = replay.run();
  } else {
    if (options.windowBook === "") throw new Error("WINDOW_BOOK is not set: the gateway has nothing to read");
    const live = new LiveSource(
      {
        l2: httpRpc("l2", options.l2Rpc, options.fetchImpl ?? fetch),
        l1: options.l1Rpc === "" ? null : httpRpc("l1", options.l1Rpc, options.fetchImpl ?? fetch),
        windowBook: options.windowBook,
        settlerUrl: options.settlerUrl ?? null,
        ...(options.fromBlock === undefined ? {} : { fromBlock: options.fromBlock }),
        ...(options.historyBlocks === undefined ? {} : { historyBlocks: options.historyBlocks }),
        ...(options.logRange === undefined ? {} : { logRange: options.logRange }),
        ...(options.gasSampleBlocks === undefined ? {} : { gasSampleBlocks: options.gasSampleBlocks }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        now,
      },
      hub,
    );
    live.start(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    stopSource = () => live.stop();
    done = new Promise<void>((resolve) => {
      closed = resolve;
    });
  }

  const gateway: GatewayServer | null =
    options.serve === false
      ? null
      : await serve({
          hub,
          profile,
          port: options.port,
          ...(options.host === undefined ? {} : { host: options.host }),
          // Devnet, and only devnet, builds the director's routes at all.
          ...(profile === "devnet" && options.enableDirector !== false
            ? {
                director: {
                  command: options.directorCommand ?? DEFAULT_DIRECTOR_COMMAND,
                  ...(options.directorCwd === undefined ? {} : { cwd: options.directorCwd }),
                },
              }
            : {}),
        });

  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    profile,
    port: gateway?.port ?? null,
    routes: gateway?.routes ?? [],
    stream: (since = 0) => hub.stream(since),
    snapshot: () => Promise.resolve(hub.snapshot()),
    status: () => hub.status(),
    events: (since = 0) => hub.events(since),
    done,
    async close() {
      stopSource();
      closed();
      hub.close();
      await gateway?.close();
    },
  };
}
