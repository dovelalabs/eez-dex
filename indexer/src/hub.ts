/**
 * The one stream — RD-2 IX-1, IX-2, TS-5.
 *
 * Everything the gateway serves passes through here: a source pushes events,
 * the hub stamps the sequence, folds the snapshot, and fans the frames out to
 * every subscriber. **Live and replay differ only in which source pushes**,
 * which is the whole of "the frontend cannot tell a replay from a live run" —
 * there is no second path for a recorded run to be served badly on.
 *
 * The hub also owns the honest half of the stream (§7 preamble): sources
 * report their health here, activity is recomputed from the fold, and a change
 * to either goes out as a `status` frame. Nothing about a quiet or broken
 * upstream is left for a client to infer from silence.
 */

import type { SlotEvent } from "../schema/index.ts";
import { SCHEMA_VERSION } from "../schema/index.ts";
import type {
  IndexerProfile,
  ReplayPosition,
  ServerFrame,
  Snapshot,
  SourceHealth,
  SourceName,
  StreamMode,
  StreamStatus,
} from "./protocol.ts";
import { emptyState, openOrderCount, reduce, toSnapshot, type StreamState } from "./reduce.ts";

/** What a source may tell the hub. */
export interface Sink {
  /** Publish one event. The hub owns `seq` and `schemaVersion`. */
  emit(event: SlotEvent): void;
  /** Report an upstream's state (§7 preamble). */
  health(health: SourceHealth): void;
  /** Report where a replay has got to, or null in live mode. */
  position(position: ReplayPosition | null): void;
  /** A replay reached the end of its recording. */
  end(): void;
}

/** How the hub is set up. */
export interface HubOptions {
  readonly mode: StreamMode;
  readonly profile: IndexerProfile;
  /** The upstreams this deployment expects to hear from. */
  readonly sources: readonly SourceHealth[];
  /** How many events to keep for late joiners and the scrubber. */
  readonly logLimit?: number;
  /** Injectable so tests are not at the mercy of the wall clock. */
  readonly now?: () => number;
}

const DEFAULT_LOG_LIMIT = 20_000;

/** The stream every reader and every source meets. */
export class EventHub implements Sink {
  readonly mode: StreamMode;
  readonly profile: IndexerProfile;

  #state: StreamState = emptyState();
  #log: SlotEvent[] = [];
  #seq = 0;
  #ended = false;
  #replay: ReplayPosition | null = null;
  #health: Map<SourceName, SourceHealth>;
  #subscribers = new Set<(frame: ServerFrame) => void>();
  #wakers = new Set<() => void>();
  #closed = false;
  #statusSignature = "";
  readonly #logLimit: number;
  readonly #now: () => number;

  constructor(options: HubOptions) {
    this.mode = options.mode;
    this.profile = options.profile;
    this.#logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#health = new Map(options.sources.map((health) => [health.source, health]));
    this.#statusSignature = signature(this.status());
  }

  /** The sequence number last issued. */
  get seq(): number {
    return this.#seq;
  }

  /** The fold's current state. */
  get state(): StreamState {
    return this.#state;
  }

  emit(event: SlotEvent): void {
    this.#seq += 1;
    const stamped = { ...event, schemaVersion: SCHEMA_VERSION, seq: this.#seq } as SlotEvent;
    this.#state = reduce(this.#state, stamped);
    this.#log.push(stamped);
    if (this.#log.length > this.#logLimit) this.#log.splice(0, this.#log.length - this.#logLimit);
    this.#publish({ type: "event", event: stamped });
    this.#publishStatusIfChanged();
  }

  health(health: SourceHealth): void {
    this.#health.set(health.source, health);
    this.#publishStatusIfChanged();
  }

  position(position: ReplayPosition | null): void {
    this.#replay = position;
    this.#publishStatusIfChanged();
  }

  end(): void {
    this.#ended = true;
    this.#publishStatusIfChanged();
  }

  /** The stream's own state, as every client is told it. */
  status(): StreamStatus {
    const activity = this.#ended
      ? "ended"
      : this.#state.openWindowId === null
        ? "loading"
        : openOrderCount(this.#state) === 0
          ? "empty"
          : "active";

    return {
      schemaVersion: SCHEMA_VERSION,
      mode: this.mode,
      profile: this.profile,
      activity,
      seq: this.#seq,
      atUnix: this.#state.atUnix === 0 ? this.#now() : this.#state.atUnix,
      sources: [...this.#health.values()],
      openWindowId: this.#state.openWindowId,
      openOrders: openOrderCount(this.#state),
      replay: this.#replay,
    };
  }

  /** The REST body (IX-1). */
  snapshot(): Snapshot {
    return toSnapshot(this.#state, this.status());
  }

  /** Events after `since`, for a scrubber or a reconnect (FE-10). */
  events(since = 0): readonly SlotEvent[] {
    return this.#log.filter((event) => event.seq > since);
  }

  /**
   * Frames, starting with a snapshot so a late joiner is level immediately.
   *
   * The returned function unsubscribes.
   */
  subscribe(listener: (frame: ServerFrame) => void): () => void {
    listener({ type: "snapshot", snapshot: this.snapshot() });
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * The library-facing view of the same stream (`Indexer.stream()`).
   *
   * It begins with everything the hub still holds after `since`, then
   * continues live — so a reader that attaches late is level with one that was
   * there from the first block, exactly as a WebSocket client is.
   */
  async *stream(since = 0): AsyncIterableIterator<SlotEvent> {
    const queue: SlotEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((frame) => {
      if (frame.type !== "event") return;
      queue.push(frame.event);
      wake?.();
    });
    const backlog = this.events(since);
    let last = since;

    try {
      for (const event of backlog) {
        last = event.seq;
        yield event;
      }
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          if (event.seq <= last) continue;
          last = event.seq;
          yield event;
        }
        if (this.#closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          this.#wakers.add(resolve);
        });
        if (wake !== null) this.#wakers.delete(wake);
        wake = null;
      }
    } finally {
      unsubscribe();
    }
  }

  /** Ends every open iterator and drops every subscriber. */
  close(): void {
    this.#closed = true;
    this.#subscribers.clear();
    for (const waker of [...this.#wakers]) waker();
    this.#wakers.clear();
  }

  #publish(frame: ServerFrame): void {
    for (const subscriber of [...this.#subscribers]) subscriber(frame);
  }

  #publishStatusIfChanged(): void {
    const status = this.status();
    const next = signature(status);
    if (next === this.#statusSignature) return;
    this.#statusSignature = next;
    this.#publish({ type: "status", status });
  }
}

/**
 * A status's meaning, without the parts that change on every event.
 *
 * `seq` and `atUnix` move constantly and say nothing new; a status frame is
 * for a change a client has to react to.
 */
function signature(status: StreamStatus): string {
  return JSON.stringify({
    mode: status.mode,
    profile: status.profile,
    activity: status.activity,
    sources: status.sources,
    openWindowId: status.openWindowId,
    openOrders: status.openOrders,
    // A replay's position moves with every event and says nothing a client
    // cannot count for itself; a status frame is for a change it has to react
    // to. Speed, length and the recording's own bounds are those.
    replay:
      status.replay === null
        ? null
        : {
            speed: status.replay.speed,
            total: status.replay.total,
            startedAtUnix: status.replay.startedAtUnix,
            endsAtUnix: status.replay.endsAtUnix,
          },
  });
}
