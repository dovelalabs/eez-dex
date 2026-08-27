/**
 * FE-10's three modes.
 *
 * Kept out of the view layer deliberately: FE-11 makes the app a single
 * reducer over the IX-2 event stream, so the pure parts live in plain modules
 * that Node can test without a browser or a bundler.
 */

/** Demo (devnet, with the director), replay (a recorded run), observe (live). */
export const MODES = ["demo", "replay", "observe"] as const;

/** Which mode the app is in. */
export type Mode = (typeof MODES)[number];

/**
 * Reads the mode from a URL query string.
 *
 * `observe` is the default because it is the honest one: pointed at a live
 * chain, no demo affordances, sparse data rendered as sparse.
 */
export function modeFromLocation(search: string): Mode {
  const requested = new URLSearchParams(search).get("mode");
  return MODES.find((mode) => mode === requested) ?? "observe";
}
