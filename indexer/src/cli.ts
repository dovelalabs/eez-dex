#!/usr/bin/env node
/**
 * `npm run start` — RD-2 IX-1.
 *
 * Points the gateway at an environment and serves it. Two shapes:
 *
 *   npm run start -- --l2 http://127.0.0.1:8545 --book 0x… --settler http://…/state
 *   npm run start -- --replay ./test/fixtures/run.json --speed 1
 *
 * The second needs no infrastructure at all, which is FE-10's "replay stands
 * alone" from the gateway's side.
 */

import { createIndexer } from "./index.ts";
import { resolveOptions } from "./options.ts";

const options = resolveOptions(process.argv.slice(2), process.env);
const indexer = await createIndexer(options);

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: indexer.schemaVersion,
    mode: indexer.mode,
    profile: indexer.profile,
    port: indexer.port,
    routes: indexer.routes,
    stream: `ws://${options.host ?? "127.0.0.1"}:${indexer.port}/stream`,
  })}\n`,
);

const stop = () => {
  void indexer.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await indexer.done;
