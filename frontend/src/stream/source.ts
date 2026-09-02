/**
 * Where the events come from — RD-2 FE-10, FE-11, FE-12.
 *
 * A source pushes frames and clock ticks at the one reducer and does nothing
 * else. That is the whole of what separates live, replay and demo: below this
 * interface there is one fold, one set of derived views and one component tree
 * (FE-11).
 *
 * The clock is the source's, not the browser's. Live, it is the wall clock,
 * because FE-5's progress bar runs on real time; in replay it is the
 * recording's own clock at the chosen speed. Either way the app renders time
 * *since the last event it received*, so a chain that stops produces a window
 * that visibly stops with it (FE-12).
 */

import type { Action } from "../state/app.ts";

/** How the app talks back to the reducer. */
export type Dispatch = (action: Action) => void;

/** A running source of frames. */
export interface Source {
  /** Begins. Idempotent. */
  start(): void;
  /** Stops, releasing every timer and socket it holds. */
  stop(): void;
  /**
   * Parks the replay at an event index, or resumes following with null.
   * Absent on live sources: a live chain has no position to seek to.
   */
  seek?(position: number | null): void;
  /** Changes the replay's clock multiplier (FE-10). */
  setSpeed?(speed: number): void;
}

/** How often the app asks the wall clock what time it is, in milliseconds. */
export const TICK_INTERVAL_MS = 250;

/** Unix seconds now. */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
