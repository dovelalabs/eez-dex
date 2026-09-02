/**
 * The demo controls are compiled out, not hidden — RD-2 FE-9.
 *
 * "Compiled out" is a claim about the artefact, so this test builds the
 * artefact. Both profiles are built: the devnet one has to contain the panel,
 * or the check on the other profile would pass for the wrong reason — a test
 * that cannot fail proves nothing.
 *
 * It is the slowest test in the package by an order of magnitude, and it earns
 * it: FE-9 is the one requirement here that no unit test can stand in for.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "vite";

const ROOT = resolve(import.meta.dirname, "..");

/** Builds the SPA for one profile into a temporary directory. */
async function bundleFor(profile: string): Promise<{ readonly files: readonly string[]; readonly text: string }> {
  const outDir = mkdtempSync(join(tmpdir(), `eez-dex-${profile}-`));
  const previous = process.env["PROFILE"];
  process.env["PROFILE"] = profile;
  try {
    await build({ root: ROOT, logLevel: "error", build: { outDir, emptyOutDir: true } });
  } finally {
    if (previous === undefined) delete process.env["PROFILE"];
    else process.env["PROFILE"] = previous;
  }

  const files = walk(outDir).map((path) => path.slice(outDir.length + 1));
  const text = walk(outDir)
    .filter((path) => /\.(js|css|html|map)$/.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  rmSync(outDir, { recursive: true, force: true });
  return { files, text };
}

function walk(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("fe9: a testnet build contains nothing of the demo controls", { timeout: 180_000 }, async () => {
  const testnet = await bundleFor("testnet");

  // The verification RD-2 states, run against the artefact:
  //   PROFILE=testnet npm run build && grep -r "director" dist/ | wc -l  ->  0
  assert.equal(
    testnet.text.split("\n").filter((line) => line.includes("director")).length,
    0,
    "no line of a testnet build may mention the director",
  );
  assert.ok(!testnet.text.includes("/director/"), "and none of its control routes exist to be called");
});

test("fe9: the same source built for devnet does contain them", { timeout: 180_000 }, async () => {
  const devnet = await bundleFor("devnet");
  assert.ok(devnet.text.includes("/director/"), "the devnet build is the one that has the controls");
});

test("fe10: the recorded runs ship with the bundle, so replay stands alone", { timeout: 180_000 }, async () => {
  const testnet = await bundleFor("testnet");
  for (const name of ["run.json", "settled.json", "rolled.json", "evicted.json", "rolled-back.json"]) {
    assert.ok(testnet.files.includes(`fixtures/${name}`), `fixtures/${name} should be emitted`);
  }
});
