/**
 * The SPA entry point — RD-2 WP-6, FE-11.
 *
 * Phase 5 stub — owner implements.
 *
 * What lands here: the trading surface (FE-1 … FE-4), the window theater
 * (FE-5 … FE-8), the demo director (FE-9, devnet only) and the mode machinery
 * (FE-10). State is a single reducer over the IX-2 event stream, so replay,
 * live and demo are one code path — which is why {@link modeFromLocation} is a
 * mode selector and not three applications.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SCHEMA_VERSION } from "@eez-dex/indexer/schema";

import { modeFromLocation } from "./mode.ts";

function App(): React.JSX.Element {
  return (
    <main>
      <h1>eez-dex</h1>
      <p>not implemented: Phase 5</p>
      <p>
        mode: {modeFromLocation(window.location.search)} · schema v{SCHEMA_VERSION}
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
