/**
 * FE-10's three modes.
 *
 * Kept out of the view layer deliberately: FE-11 makes the app a single
 * reducer over the IX-2 event stream, so the pure parts live in plain modules
 * that Node can test without a browser or a bundler.
 */

/** Demo (devnet, with the scripted controls), replay (a recorded run), observe (live). */
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

/**
 * What the trading surface may do — FE-10.
 *
 * `disabled` — replay: the run is a recording, and an order placed against it
 * would be a lie about a chain that is not there.
 * `read_only` — observe or demo without a wallet on this chain: quotes are
 * real, placement is not offered.
 * `live` — a wallet is connected to the configured chain.
 */
export const TRADING_STATES = ["disabled", "read_only", "live"] as const;

/** One of them. */
export type TradingState = (typeof TRADING_STATES)[number];

/** Whether this mode and wallet session may place an order. */
export function tradingState(mode: Mode, walletConnected: boolean): TradingState {
  if (mode === "replay") return "disabled";
  return walletConnected ? "live" : "read_only";
}
