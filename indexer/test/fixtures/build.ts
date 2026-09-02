/**
 * Writes `run.json` — the stand-in recorded run (RD-2 HX-5, TS-5).
 *
 *   node test/fixtures/build.ts
 *
 * The fixture is the *output of the live path*: `test/script.ts` drives the
 * real {@link LiveSource} over a scripted chain and this writes down what the
 * gateway emitted. `test/replay.test.ts` regenerates it and fails if the
 * committed file has drifted, so the fixture cannot quietly stop being a
 * recording of what this code does.
 *
 * WP-4 owns the real HX-5 fixture. Both conform to the frozen schema, which is
 * the arbiter if they ever disagree.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION } from "../../schema/index.ts";
import { recordScriptedRun } from "../script.ts";

const { events } = await recordScriptedRun();
const path = fileURLToPath(new URL("run.json", import.meta.url));
await writeFile(path, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, events }, null, 2)}\n`, "utf8");
process.stdout.write(`${path}: ${events.length} events\n`);
