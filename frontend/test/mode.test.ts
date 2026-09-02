/**
 * Modes and configuration — RD-2 FE-9, FE-10, EC-1.
 *
 * FE-10 defaults to `observe`, the mode that makes no claims about what is on
 * the chain, and disables the trading surface in replay, where an order would
 * be a claim about a chain that is not there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MODES, modeFromLocation, TRADING_STATES, tradingState } from "../src/mode.ts";
import { buildProfile, readConfig } from "../src/config.ts";

test("fe10: the three modes are demo, replay and observe", () => {
  assert.deepEqual([...MODES], ["demo", "replay", "observe"]);
});

test("fe10: an unknown or absent mode falls back to observe", () => {
  assert.equal(modeFromLocation(""), "observe");
  assert.equal(modeFromLocation("?mode=theatre"), "observe");
});

test("fe10: each mode is selectable from the url", () => {
  assert.equal(modeFromLocation("?mode=demo"), "demo");
  assert.equal(modeFromLocation("?mode=replay"), "replay");
  assert.equal(modeFromLocation("?mode=observe"), "observe");
});

test("fe10: trading is off in replay, read-only until a wallet is connected", () => {
  assert.deepEqual([...TRADING_STATES], ["disabled", "read_only", "live"]);
  assert.equal(tradingState("replay", false), "disabled");
  assert.equal(tradingState("replay", true), "disabled", "a wallet does not make a recording tradable");
  assert.equal(tradingState("observe", false), "read_only");
  assert.equal(tradingState("observe", true), "live");
  assert.equal(tradingState("demo", false), "read_only");
  assert.equal(tradingState("demo", true), "live");
});

test("fe9: an unbuilt profile is devnet, and nothing in the query string can change it", () => {
  assert.equal(buildProfile(), "devnet", "outside a build there is no define, and devnet is the safe assumption");
  assert.equal(readConfig({}, "?profile=mainnet").profile, "devnet");
  assert.equal(readConfig({}, "", "testnet").profile, "testnet");
});

test("ec1: the fee parameters default to the launch setting", () => {
  const fee = readConfig({}, "").fee;
  assert.deepEqual(fee, { mode: "bps", bps: 1n, fixedA: 0n, fixedB: 0n, routeFeeModel: "absorb" });

  const fixed = readConfig({ VITE_FEE_MODE: "fixed", VITE_FEE_FIXED_A: "5", VITE_ROUTE_FEE_MODEL: "recover" }, "").fee;
  assert.deepEqual(fixed, { mode: "fixed", bps: 1n, fixedA: 5n, fixedB: 0n, routeFeeModel: "recover" });
});

test("fe10: the query string points one bundle at another gateway, recording or clock", () => {
  const config = readConfig(
    { VITE_INDEXER_URL: "http://built-in:8080" },
    "?mode=replay&indexer=http://other:9000&fixture=/fixtures/evicted.json&speed=0",
  );
  assert.equal(config.mode, "replay");
  assert.equal(config.indexerUrl, "http://other:9000");
  assert.equal(config.fixtureUrl, "/fixtures/evicted.json");
  assert.equal(config.speed, 0, "zero is a speed, not a missing value");

  const defaults = readConfig({}, "");
  assert.equal(defaults.indexerUrl, "http://127.0.0.1:8080");
  assert.equal(defaults.fixtureUrl, "/fixtures/run.json");
  assert.equal(defaults.speed, 1);
  assert.equal(defaults.chainIdHex, null, "no chain configured is stated, not guessed");
  assert.equal(defaults.windowBook, "");
});

test("fe11: the pair's display units come from configuration", () => {
  const config = readConfig(
    { VITE_ASSET_A_SYMBOL: "WETH", VITE_ASSET_B_SYMBOL: "USDC", VITE_ASSET_B_DECIMALS: "6" },
    "",
  );
  assert.equal(config.assetA.symbol, "WETH");
  assert.equal(config.assetB.symbol, "USDC");
  assert.equal(config.assetB.decimals, 6);
  assert.equal(config.assetA.decimals, 18);
});
