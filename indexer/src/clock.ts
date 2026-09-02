/**
 * The clock, as a seam — RD-2 IX-1, FE-12.
 *
 * Replay differs from live in exactly two things: where the events come from
 * and what paces them. Making the clock injectable is what keeps that true —
 * and it is what lets the replay-equals-live test run a recorded run at
 * infinite speed without a single real timer.
 */

/** Wall time, and a way to wait. */
export interface Clock {
  /** Unix seconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Real time. */
export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
};

/**
 * A clock that never waits, and that advances by what it was asked to wait.
 *
 * Tests use it so a 200-slot recording replays in a millisecond while the
 * stream's own timestamps still move exactly as they did when recorded.
 */
export function fastClock(startUnix = 0): Clock {
  let unix = startUnix;
  return {
    now: () => unix,
    sleep: (ms) => {
      unix += Math.round(ms / 1000);
      return Promise.resolve();
    },
  };
}
