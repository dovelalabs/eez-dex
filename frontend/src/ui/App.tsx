/**
 * The whole surface — RD-2 §7, FE-1 … FE-12.
 *
 * Two things against one stream: a trading surface people place orders through
 * (FE-1 … FE-4) and a window theater that makes the mechanism legible (FE-5 …
 * FE-8). Both read the same state, produced by the same reducer, fed by
 * whichever source this mode uses (FE-11).
 *
 * `App` is a pure function of `(state, api)`. That is what lets the end-to-end
 * test render the real component tree over a recorded run with no browser, no
 * gateway and no wallet behind it (TS-5).
 */

import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

import { DemoControls } from "@demo-controls";
import type { AppState } from "../state/app.ts";
import { Amortisation } from "./Amortisation.tsx";
import { Header, Scrubber } from "./Chrome.tsx";
import { Drift } from "./Drift.tsx";
import { MirrorInspector } from "./MirrorInspector.tsx";
import { Orders } from "./Orders.tsx";
import { SwapPanel } from "./SwapPanel.tsx";
import { Theater } from "./Theater.tsx";
import type { AppApi } from "./api.ts";
import { Notice } from "./parts.tsx";

export function App({ state, api }: { readonly state: AppState; readonly api: AppApi }): React.JSX.Element {
  return (
    <main className="app">
      <Header state={state} api={api} />

      {state.connection === "failed" ? (
        <Notice tone="bad">
          The stream cannot be read: {state.connectionDetail ?? "no detail"}. Nothing below this line is being updated.
        </Notice>
      ) : state.connection === "closed" ? (
        <Notice tone="warn">
          Disconnected from the stream ({state.connectionDetail ?? "no detail"}); retrying. What is on screen is the
          last thing that actually arrived.
        </Notice>
      ) : null}

      <div className="columns">
        <div className="stack">
          <SwapPanel state={state} api={api} />
          <Orders state={state} api={api} />
        </div>
        <div className="stack">
          <Theater state={state} />
          <Amortisation state={state} />
          <Drift state={state} />
          <MirrorInspector state={state} />
        </div>
      </div>

      <Scrubber state={state} api={api} />
      <DemoControls state={state} api={api} />

      <footer className="row small faint">
        <span>
          {state.config.mode} · schema v{SCHEMA_VERSION} · seq {state.chain.seq}
        </span>
        <span>Quotes are indicative against the mirror; the binding price is the one the L1 leg returns.</span>
      </footer>
    </main>
  );
}
