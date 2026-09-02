/**
 * The replay source: an HX-5 recording, played at a clock — RD-2 FE-10, TS-5.
 *
 * "Replay stands alone" (§10): the recorded run plays on the frontend with **no
 * infrastructure behind it**, so this source reads the recording as a static
 * asset and paces it itself. Everything downstream is the same: the same
 * frames, the same reducer, the same views. Pointing the app at a gateway that
 * is itself replaying is the other half of the same requirement, and it goes
 * through {@link ../stream/socket.ts} without a line of difference — the app
 * cannot tell a replay from a live run, which is the point (IX-1).
 *
 * The scrubber is a consequence of the reducer being pure: seeking is folding
 * a prefix of the tape, not a second playback path.
 */

import type { SlotEvent } from "@eez-dex/indexer/schema";

import { parseRecording, UnreadableStream } from "./frames.ts";
import { TICK_INTERVAL_MS, type Dispatch, type Source } from "./source.ts";

/** The longest recorded gap to honour, so an idle stretch stays watchable. */
export const MAX_GAP_SECONDS = 60;

/** What the replay source needs. */
export interface ReplayOptions {
  /** Where the recording is. A static file: `/fixtures/run.json` by default. */
  readonly fixtureUrl: string;
  readonly dispatch: Dispatch;
  /** Clock multiplier; 1 is real time, 0 is as fast as the machine allows. */
  readonly speed?: number;
  readonly fetchImpl?: typeof fetch;
  /** Real milliseconds now, injectable so a test can drive the clock. */
  readonly monotonic?: () => number;
}

/** Plays a recorded run into the reducer. */
export class ReplaySource implements Source {
  #events: readonly SlotEvent[] = [];
  #emitted = 0;
  #speed: number;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** Real time when the last event was emitted, for the clock between events. */
  #lastRealMs = 0;
  #lastEventUnix = 0;

  readonly #options: ReplayOptions;

  constructor(options: ReplayOptions) {
    this.#options = options;
    this.#speed = options.speed ?? 1;
  }

  start(): void {
    this.#stopped = false;
    this.#options.dispatch({ type: "connection", state: "connecting", detail: this.#options.fixtureUrl });
    void this.#load();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#ticker !== null) clearInterval(this.#ticker);
    this.#timer = null;
    this.#ticker = null;
  }

  /** FE-10's scrubber. Forward past what has played fast-forwards to it. */
  seek(position: number | null): void {
    if (position !== null && position > this.#emitted) {
      while (this.#emitted < Math.min(position, this.#events.length)) this.#emit();
    }
    this.#options.dispatch({ type: "seek", position });
    this.#publish();
  }

  /** Changes the clock multiplier mid-run (FE-10). */
  setSpeed(speed: number): void {
    this.#speed = Math.max(0, speed);
    this.#publish();
  }

  async #load(): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.#options.fixtureUrl);
      if (!response.ok) throw new Error(`the recording answered ${response.status}`);
      this.#events = parseRecording(await response.json());
    } catch (error) {
      const detail = error instanceof UnreadableStream ? error.message : `no recording: ${message(error)}`;
      this.#options.dispatch({ type: "connection", state: "failed", detail });
      return;
    }
    if (this.#stopped) return;

    this.#options.dispatch({ type: "connection", state: "open", detail: this.#options.fixtureUrl });
    this.#lastRealMs = this.#now();
    this.#lastEventUnix = this.#events[0]?.atUnix ?? 0;
    this.#publish();
    // The clock between events, so a recorded 12 s slot takes 12 s of screen
    // time at 1× and the progress bar moves on the recording's own time.
    this.#ticker = setInterval(() => this.#tick(), TICK_INTERVAL_MS);
    this.#schedule();
  }

  #now(): number {
    return (this.#options.monotonic ?? (() => Date.now()))();
  }

  #tick(): void {
    if (this.#stopped || this.#emitted === 0) return;
    const elapsed = ((this.#now() - this.#lastRealMs) / 1000) * (this.#speed === 0 ? 0 : this.#speed);
    this.#options.dispatch({ type: "tick", nowUnix: Math.floor(this.#lastEventUnix + elapsed) });
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#emitted >= this.#events.length) {
      this.#publish(true);
      return;
    }
    const next = this.#events[this.#emitted];
    if (next === undefined) return;
    const gap =
      this.#emitted === 0 || this.#speed === 0
        ? 0
        : Math.min(Math.max(0, next.atUnix - this.#lastEventUnix), MAX_GAP_SECONDS);
    const delay = (gap * 1000) / (this.#speed === 0 ? 1 : this.#speed);

    this.#timer = setTimeout(
      () => {
        this.#emit();
        this.#schedule();
      },
      this.#speed === 0 ? 0 : delay,
    );
  }

  #emit(): void {
    const event = this.#events[this.#emitted];
    if (event === undefined) return;
    this.#emitted += 1;
    this.#lastEventUnix = event.atUnix;
    this.#lastRealMs = this.#now();
    this.#options.dispatch({ type: "frame", frame: { type: "event", event } });
    this.#publish();
  }

  /** Where the run has got to — the same shape the gateway publishes (FE-10). */
  #publish(ended = false): void {
    this.#options.dispatch({
      type: "replay",
      replay: {
        speed: this.#speed,
        position: this.#emitted,
        total: this.#events.length,
        startedAtUnix: this.#events[0]?.atUnix ?? null,
        endsAtUnix: this.#events[this.#events.length - 1]?.atUnix ?? null,
        ended,
      },
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
