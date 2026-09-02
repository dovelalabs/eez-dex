/**
 * The quote, the cost line and the formatting they are printed with —
 * RD-2 FE-1, FE-3, TS-5, CT-2, CT-12.
 *
 * The arithmetic is pinned twice: against `Mirror.sol`'s own rules (round the
 * price step up so the output rounds down; prices B per A either way), and
 * against the recorded run's numbers, where the fee this module computes has
 * to equal the fee the book emitted **to the wei**.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Order, SlotEvent } from "@eez-dex/indexer/schema";

import type { FeeParams } from "../src/config.ts";
import {
  formatBps,
  formatDuration,
  formatEth,
  formatPercent,
  formatPriceX96,
  formatUnits,
  formatWeiCost,
  parseUnits,
  shortAddress,
} from "../src/domain/format.ts";
import { advance, ageSlots, quote, valueIn } from "../src/domain/mirror.ts";
import { Q96, differenceBps, spotPriceX96 } from "../src/domain/q96.ts";
import { buildQuote, protocolFee } from "../src/domain/quote.ts";
import { mirror } from "./factory.ts";

/** EC-1 at launch: one basis point, and the route fee absorbed. */
const LAUNCH_FEE: FeeParams = { mode: "bps", bps: 1n, fixedA: 0n, fixedB: 0n, routeFeeModel: "absorb" };

const POOL = mirror("0").state;

function fixtureOrders(name: string): readonly Order[] {
  const events = JSON.parse(readFileSync(new URL(`../../scenario/fixtures/${name}`, import.meta.url), "utf8")) as SlotEvent[];
  return events.filter((event): event is SlotEvent & { kind: "order" } => event.kind === "order").map((event) => event.order);
}

test("ec1: the protocol fee equals the fee the recorded run's book emitted, to the wei", () => {
  const filled = fixtureOrders("settled.json").filter((order) => order.fill !== null);
  assert.ok(filled.length >= 8, "the happy path records eight fills (A.6)");

  for (const order of filled) {
    assert.equal(
      protocolFee(LAUNCH_FEE, BigInt(order.sellAmount), order.side).toString(),
      order.fill?.feeAmount,
      `order ${order.id}`,
    );
    assert.equal(order.fill?.routeFeeAmount, "0", "the route fee is absorbed at launch (EC-1)");
  }
});

test("ec1: the fixed shape charges per order, per side", () => {
  const fixed: FeeParams = { mode: "fixed", bps: 0n, fixedA: 7n, fixedB: 11n, routeFeeModel: "absorb" };
  assert.equal(protocolFee(fixed, 10n ** 18n, "SELL_A_FOR_B"), 7n);
  assert.equal(protocolFee(fixed, 10n ** 18n, "SELL_B_FOR_A"), 11n);
});

test("ct2: the mirror's spot is B per A regardless of side", () => {
  const spot = spotPriceX96(POOL);
  // ~3000 B per A, in Q96 — the pair the recorded runs were priced at.
  assert.equal(spot / Q96, 2999n);
  assert.equal(valueIn(10n ** 18n, spot, "SELL_A_FOR_B") / 10n ** 18n, 2999n, "one A is worth ~3000 B");

  const oneEthOfB = valueIn(3000n * 10n ** 18n, spot, "SELL_B_FOR_A");
  assert.ok(oneEthOfB > 999n * 10n ** 15n && oneEthOfB < 1001n * 10n ** 15n, "and ~3000 B is worth one A");
});

test("ct12: a quote walks the curve, rounds down, and moves the price the right way", () => {
  const oneEth = 10n ** 18n;
  const out = quote(POOL, oneEth, "SELL_A_FOR_B");
  const linear = valueIn(oneEth, spotPriceX96(POOL), "SELL_A_FOR_B");

  assert.ok(out > 0n);
  assert.ok(out < linear, "selling A into the curve gets less than the spot valuation: that gap is the impact");

  const after = advance(POOL, oneEth, "SELL_A_FOR_B").post;
  assert.ok(BigInt(after.sqrtPriceX96) < BigInt(POOL.sqrtPriceX96), "selling A moves the price down");

  const upward = advance(POOL, 3000n * oneEth, "SELL_B_FOR_A").post;
  assert.ok(BigInt(upward.sqrtPriceX96) > BigInt(POOL.sqrtPriceX96), "selling B moves the price up");
});

test("ct12: a bigger order gets a worse price — the curve is monotonic", () => {
  const small = quote(POOL, 10n ** 18n, "SELL_A_FOR_B");
  const large = quote(POOL, 100n * 10n ** 18n, "SELL_A_FOR_B");
  assert.ok(large > small * 99n, "sanity: a hundred times the size returns roughly a hundred times the output");
  assert.ok(large < small * 100n, "but strictly less, because the price moved against it");
});

test("ct8: the mirror's age is measured in whole L1 slots and never goes negative", () => {
  assert.equal(ageSlots(1_000_012, 1_000_000), 1);
  assert.equal(ageSlots(1_000_023, 1_000_000), 1);
  assert.equal(ageSlots(1_000_024, 1_000_000), 2);
  assert.equal(ageSlots(999_000, 1_000_000), 0, "a mirror stamped in the future ages to zero");
  assert.equal(ageSlots(1_000_000, 0), 0);
});

test("fe1: a quote carries the fee, the limit and the mirror's age", () => {
  const snapshot = mirror("0", { mirrorTimestamp: 1_000_000 });
  const result = buildQuote({
    mirror: snapshot,
    sellAmount: 10n ** 18n,
    side: "SELL_A_FOR_B",
    slippageBps: 50,
    fee: LAUNCH_FEE,
    nowUnix: 1_000_026,
  });

  assert.ok(result.ok);
  const value = result.quote;
  assert.equal(value.fee, 10n ** 14n, "1 bp of one whole unit");
  assert.equal(value.netIn, 10n ** 18n - 10n ** 14n);
  assert.equal(value.amountOut, quote(snapshot.state, value.netIn, "SELL_A_FOR_B"));
  assert.equal(value.minBuyAmount, (value.amountOut * 9950n) / 10_000n, "the limit is the quote less the slippage");
  assert.equal(value.mirrorAgeSlots, 2);
  assert.equal(value.routeFee, 0n, "absorbed at launch");
});

test("fe1: a quote with nothing behind it is a stated problem, not a number", () => {
  const base = { sellAmount: 10n ** 18n, side: "SELL_A_FOR_B", slippageBps: 50, fee: LAUNCH_FEE, nowUnix: 0 } as const;

  const noMirror = buildQuote({ ...base, mirror: null });
  assert.equal(noMirror.ok === false && noMirror.problem.kind, "no_mirror");

  const noAmount = buildQuote({ ...base, mirror: mirror("0"), sellAmount: 0n });
  assert.equal(noAmount.ok === false && noAmount.problem.kind, "no_amount");

  const dust = buildQuote({ ...base, mirror: mirror("0"), sellAmount: 1n, fee: { ...LAUNCH_FEE, mode: "fixed", fixedA: 5n } });
  assert.equal(dust.ok === false && dust.problem.kind, "fee_exceeds_order");

  const dry = buildQuote({ ...base, mirror: mirror("0", { state: { ...POOL, liquidity: "0" } }) });
  assert.equal(dry.ok === false && dry.problem.kind, "no_liquidity");
});

test("fe3: the route-fee share is charged only when the model recovers it", () => {
  const recovering = buildQuote({
    mirror: mirror("0"),
    sellAmount: 10n ** 18n,
    side: "SELL_A_FOR_B",
    slippageBps: 0,
    fee: { ...LAUNCH_FEE, routeFeeModel: "recover" },
    routeFee: 5_000n,
    nowUnix: 0,
  });
  assert.ok(recovering.ok);
  assert.equal(recovering.quote.routeFee, 5_000n);

  const absorbing = buildQuote({
    mirror: mirror("0"),
    sellAmount: 10n ** 18n,
    side: "SELL_A_FOR_B",
    slippageBps: 0,
    fee: LAUNCH_FEE,
    routeFee: 5_000n,
    nowUnix: 0,
  });
  assert.ok(absorbing.ok);
  assert.equal(absorbing.quote.routeFee, 0n, "absorb means the user is charged nothing, whatever is passed");
});

test("fe11: amounts format and parse without going through a double", () => {
  assert.equal(formatUnits(1_234_567_890_123_456_789n, 18, 4), "1.2345");
  assert.equal(formatUnits(10n ** 21n, 18, 2), "1,000.00");
  assert.equal(formatUnits(0n, 18, 4), "0.0000");
  assert.equal(formatUnits(-5n * 10n ** 17n, 18, 2), "-0.50");
  assert.equal(parseUnits("1.5", 18), 15n * 10n ** 17n);
  assert.equal(parseUnits("0.000000000000000001", 18), 1n);
  assert.equal(parseUnits("1.9999999999999999999999", 18), 1_999_999_999_999_999_999n, "excess precision truncates");
  assert.equal(parseUnits("", 18), null);
  assert.equal(parseUnits("abc", 18), null);
  assert.equal(parseUnits("-1", 18), null);

  const big = 123_456_789_012_345_678_901_234_567_890n;
  assert.equal(parseUnits(formatUnits(big, 18, 18).replace(/,/g, ""), 18), big, "a round trip is exact");
});

test("fe11: prices, gas and ratios print in the units they are read in", () => {
  assert.equal(formatPriceX96(spotPriceX96(POOL), 18, 18, 2), "2,999.99");
  assert.equal(formatEth(10n ** 18n, 2), "1.00");
  assert.equal(formatWeiCost(282_000_000_000_000n), "0.000282 ETH");
  assert.equal(formatWeiCost(1_000n), "0.00 gwei");
  assert.equal(formatPercent(0.0333), "3.3%");
  assert.equal(formatBps(12.5), "+12.5 bp");
  assert.equal(formatBps(-3), "-3.0 bp");
  assert.equal(formatDuration(75), "1m 15s");
  assert.equal(formatDuration(-4), "0s");
  assert.equal(shortAddress("0x14dc79964da2c08b23698b3d3cc7ca32193d9955"), "0x14dc…9955");
});

test("fe7: the drift between two prices is signed and in basis points", () => {
  assert.equal(differenceBps(10_100n, 10_000n), 100);
  assert.equal(differenceBps(9_900n, 10_000n), -100);
  assert.equal(differenceBps(10_000n, 0n), null);
});
