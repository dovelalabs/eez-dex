import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * FE-11: a static SPA. There is no server behind it — the indexer (IX-1) is
 * the only thing it talks to, and in replay mode not even that.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
});
