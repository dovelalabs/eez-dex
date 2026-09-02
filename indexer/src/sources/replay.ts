/**
 * The replay source — RD-2 IX-1, FE-10, HX-5, TS-5.
 *
 * "The frontend cannot tell a replay from a live run" is a requirement about
 * *code*, not about fidelity of imitation: the recorded run is pushed at the
 * same hub, through the same fold-and-fan-out, in the same frames. There is no
 * replay-shaped path for a bug to live on. What differs is this file — the
 * source — and the clock that paces it.
 *
 * The recording is not re-derived on the way through. Every event is served as
 * it was recorded, sequence numbers re-issued by the hub so a stream is
 * monotonic from its own start; for a well-formed recording that re-issue is
 * the identity, which is the equality TS-5 asserts.
 */

import { readFile } from "node:fs/promises";

import type { SlotEvent } from "../../schema/index.ts";
import { SCHEMA_VERSION } from "../../schema/index.ts";
import type { Clock } from "../clock.ts";
import { systemClock } from "../clock.ts";
import type { Sink } from "../hub.ts";
import { parseSlotEvent, SchemaError } from "../validate.ts";

/** A recorded run: HX-5's fixture, and what this gateway itself emits. */
export interface RecordedRun {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly events: readonly SlotEvent[];
}

/**
 * Reads a recorded run, refusing anything the frozen schema does not allow.
 *
 * Two shapes are accepted because two producers write them: this gateway's
 * `{schemaVersion, events}` document and a bare event log. Everything inside
 * is checked event by event — a fixture that does not conform is refused with
 * the path of the first field that does not, rather than replayed into a
 * frontend that would render it wrong (`schema/version.ts`).
 */
export function parseRecordedRun(value: unknown): RecordedRun {
  const raw = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
      ? ((value as { events: unknown[] }).events)
      : null;

  if (raw === null) {
    throw new SchemaError("run", "expected an event log, or an object with an `events` array");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    events: raw.map((event, index) => parseSlotEvent(event, `run.events[${index}]`)),
  };
}

/** Loads a recorded run from disk. */
export async function loadRecordedRun(path: string): Promise<RecordedRun> {
  return parseRecordedRun(JSON.parse(await readFile(path, "utf8")));
}

/** How a recorded run is paced. */
export interface ReplayOptions {
  /** Clock multiplier: 1 is real time, 0 is as fast as the socket allows. */
  readonly speed?: number;
  readonly clock?: Clock;
  /** The longest gap to honour, so a recording with an idle hour is watchable. */
  readonly maxGapSeconds?: number;
}

const DEFAULT_MAX_GAP_SECONDS = 60;

/** Serves a recorded run at real or accelerated clock (FE-10). */
export class ReplaySource {
  #stopped = false;
  #position = 0;

  readonly #run: RecordedRun;
  readonly #sink: Sink;
  readonly #speed: number;
  readonly #clock: Clock;
  readonly #maxGap: number;

  constructor(run: RecordedRun, sink: Sink, options: ReplayOptions = {}) {
    this.#run = run;
    this.#sink = sink;
    this.#speed = options.speed ?? 1;
    this.#clock = options.clock ?? systemClock;
    this.#maxGap = options.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
    if (this.#speed < 0) throw new RangeError("replay speed cannot be negative");
  }

  /** Where the replay has got to, for FE-10's scrubber. */
  position(): void {
    const events = this.#run.events;
    this.#sink.position({
      speed: this.#speed,
      position: this.#position,
      total: events.length,
      startedAtUnix: events[0]?.atUnix ?? null,
      endsAtUnix: events[events.length - 1]?.atUnix ?? null,
    });
  }

  /** Walks the recording, pacing it, until it ends or {@link stop} is called. */
  async run(): Promise<void> {
    this.#sink.health({ source: "fixture", state: "ok", detail: null, observedAtUnix: this.#clock.now() });
    this.position();

    let previous: number | null = null;
    for (const event of this.#run.events) {
      if (this.#stopped) return;
      if (previous !== null && this.#speed > 0) {
        const gap = Math.min(Math.max(0, event.atUnix - previous), this.#maxGap);
        if (gap > 0) await this.#clock.sleep((gap * 1000) / this.#speed);
      }
      if (this.#stopped) return;
      previous = event.atUnix;
      this.#position += 1;
      this.#sink.emit(event);
      this.position();
    }

    // A recording that has ended is a first-class state, not a stream that
    // went quiet (§7 preamble): the frontend shows a finished run, not a
    // stalled chain.
    this.#sink.end();
  }

  /** Stops the walk. Everything already emitted stays served. */
  stop(): void {
    this.#stopped = true;
  }
}
