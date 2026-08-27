/**
 * The Phase 5 entry point exists and type-checks. `modeFromLocation` is the
 * one piece of it that is real: FE-10 defaults to `observe`, the mode that
 * makes no claims about what is on the chain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MODES, modeFromLocation } from "../src/mode.ts";

test("fe10: the three modes are demo, replay and observe", () => {
  assert.deepEqual([...MODES], ["demo", "replay", "observe"]);
});

test("fe10: an unknown or absent mode falls back to observe", () => {
  assert.equal(modeFromLocation(""), "observe");
  assert.equal(modeFromLocation("?mode=director"), "observe");
});

test("fe10: each mode is selectable from the url", () => {
  assert.equal(modeFromLocation("?mode=demo"), "demo");
  assert.equal(modeFromLocation("?mode=replay"), "replay");
  assert.equal(modeFromLocation("?mode=observe"), "observe");
});
