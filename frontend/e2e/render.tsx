/**
 * The end-to-end test's renderer — RD-2 TS-5.
 *
 * The real `App`, rendered to a string. This is the only file the end-to-end
 * suite adds to what ships: it stands in for the browser's `createRoot`, and
 * for the `api` the browser wires to a wallet and a socket — a test asserting
 * what a recorded run *renders* has no business placing an order.
 */

import { renderToStaticMarkup } from "react-dom/server";

import type { AppState } from "../src/state/app.ts";
import { App } from "../src/ui/App.tsx";
import type { AppApi } from "../src/ui/api.ts";

/** An api that answers every call and does nothing, because nothing is live. */
const INERT: AppApi = {
  dispatch: () => {},
  connectWallet: () => Promise.resolve(),
  placeOrder: () => Promise.resolve(),
  cancelOrder: () => Promise.resolve(),
  seek: () => {},
  setSpeed: () => {},
  runControl: () => Promise.resolve(),
};

/** Renders the whole surface for one state. */
export function renderApp(state: AppState): string {
  return renderToStaticMarkup(<App state={state} api={INERT} />);
}
