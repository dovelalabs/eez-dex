import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * FE-11: a static SPA. There is no server behind it — the indexer (IX-1) is
 * the only thing it talks to, and in replay mode not even that.
 *
 * Two things this config decides that the app cannot decide for itself:
 *
 * **The profile compiles the demo controls out (FE-9).** `@demo-controls`
 * resolves to the devnet panel on `PROFILE=devnet` and to a module that
 * renders nothing on every other profile. Off devnet the panel is never
 * imported, so nothing it contains — including the gateway routes it would
 * call — reaches the bundle. That is what "compiled out, not hidden" means,
 * and `test/bundle.test.ts` holds it.
 *
 * **The recorded runs ship as assets (FE-10).** Replay has to stand alone, so
 * WP-4's fixtures are served in development and emitted into `dist/fixtures/`
 * at build. They are read from `scenario/fixtures/`, never copied into this
 * package: a second copy is a copy that goes stale.
 */

const PROFILE = process.env["PROFILE"] ?? "devnet";

const FIXTURE_DIR = resolve(import.meta.dirname, "../scenario/fixtures");

/** WP-4's recorded runs, served in dev and emitted at build (HX-5, FE-10). */
function fixtures(): Plugin {
  const names = (): readonly string[] => readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

  return {
    name: "eez-dex-fixtures",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        const match = /^\/fixtures\/([\w.-]+\.json)$/.exec(path);
        if (match === null || !names().includes(match[1] ?? "")) {
          next();
          return;
        }
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(readFileSync(resolve(FIXTURE_DIR, match[1] ?? ""), "utf8"));
      });
    },
    generateBundle() {
      for (const name of names()) {
        this.emitFile({
          type: "asset",
          fileName: `fixtures/${name}`,
          source: readFileSync(resolve(FIXTURE_DIR, name), "utf8"),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), fixtures()],
  define: { __PROFILE__: JSON.stringify(PROFILE) },
  resolve: {
    alias: {
      "@demo-controls":
        PROFILE === "devnet"
          ? resolve(import.meta.dirname, "src/director/panel.tsx")
          : resolve(import.meta.dirname, "src/ui/controls-off.tsx"),
    },
  },
  // Source maps on devnet, where the demo is debugged, and not on the profiles
  // that get deployed: a map republishes every source file — comments included
  // — beside the bundle, which is both more than a deployment needs to ship and
  // enough to make FE-9's "is any of this in the output" check answer on prose
  // instead of on code.
  build: { outDir: "dist", sourcemap: PROFILE === "devnet" },
});
