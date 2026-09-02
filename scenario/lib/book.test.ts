/**
 * The settlement oracle, against the requirements it re-implements.
 *
 * These are not tests of `WindowBook.sol` — WP-2 owns those. They are tests of
 * the *second* implementation the scenario asserts with: if the oracle were
 * wrong in the same direction as a contract bug, the failure matrix would pass
 * through it. So each one pins a rule from RD-2's text rather than a number
 * copied out of a contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SettlementRevert,
  buildLeg,
  chargeFees,
  expectSettlement,
  omittedFillable,
  selectFillable,
  settleLeg,
  settles,
} from "./book.ts";
import type { BookOrder, BookParams } from "./book.ts";
import { Q96, mulDiv, spotPriceX96 } from "./math.ts";
import type { Pool } from "./pool.ts";
import { sqrtPriceForPrice } from "./pool.ts";
import { Rng } from "./rng.ts";

const ONE = 10n ** 18n;

/** The launch configuration: 1 bp, route fee absorbed (EC-1). */
const PARAMS: BookParams = {
  feeMode: "bps",
  feeBps: 1n,
  feeFixedA: 0n,
  feeFixedB: 0n,
  routeFeeModel: "absorb",
  routeFeeWei: 0n,
  assetAIsNative: true,
};

/** A deep pool at 3000 B per A, so the scripted burst barely moves it. */
function poolAt(price: bigint, liquidity = 4_000_000n * ONE): Pool {
  return { sqrtPriceX96: sqrtPriceForPrice(price, 1n), liquidity, fee: 3000n };
}

function id(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** An A-side order: sells `sell` of A, wants at least `minBuy` of B. */
function sellA(n: number, sell: bigint, minBuy: bigint): BookOrder {
  return { id: id(n), side: "SELL_A_FOR_B", sellAmount: sell, minBuyAmount: minBuy };
}

/** A B-side order: sells `sell` of B, wants at least `minBuy` of A. */
function sellB(n: number, sell: bigint, minBuy: bigint): BookOrder {
  return { id: id(n), side: "SELL_B_FOR_A", sellAmount: sell, minBuyAmount: minBuy };
}

test("ct9: the residual is Σ buys − Σ sells at the clearing price", () => {
  const pool = poolAt(3000n);
  const price = spotPriceX96(pool.sqrtPriceX96);
  const orders = [sellA(1, 10n * ONE, 0n), sellB(2, 12_000n * ONE, 0n)];
  const charged = chargeFees(orders, PARAMS, price);
  const leg = buildLeg(charged, price);

  // 10 A against 12000 B at 3000 B per A: the B side is worth 4 A, so 6 A
  // remains and the residual sells A.
  assert.equal(leg.residualSide, "SELL_A_FOR_B");
  assert.equal(leg.residualIn, charged.sumA - mulDiv(charged.sumB, Q96, price));
  assert.equal(leg.crossPot, mulDiv(charged.sumB, Q96, price));
  assert.equal(leg.residualIn + leg.crossPot, charged.sumA);
});

test("ct12: Σ outputs never exceed the leg's output plus the crossed volume", () => {
  const rng = new Rng(20260902n);
  for (let round = 0; round < 200; round += 1) {
    const pool = poolAt(3000n);
    const orders: BookOrder[] = [];
    for (let i = 0; i < rng.intInRange(2, 8); i += 1) {
      const sellsA = rng.chance(1, 2);
      orders.push(
        sellsA
          ? sellA(i, rng.inRange(ONE / 10n, 20n * ONE), 0n)
          : sellB(i, rng.inRange(100n * ONE, 60_000n * ONE), 0n),
      );
    }

    const settlement = expectSettlement(orders, PARAMS, pool, pool);
    const outputs = settlement.fills.reduce((total, fill) => total + fill.amountOut, 0n);
    const available = settlement.result.amountOut + settlement.leg.crossPot +
      (settlement.leg.residualIsA ? settlement.charged.sumB : settlement.charged.sumA);
    assert.ok(outputs <= available, `round ${round}: ${outputs} > ${available}`);
    // Whatever is left is dust, and dust is never negative — a negative would
    // mean the protocol paid out more than it held (EC-2).
    assert.ok(settlement.dustCrossedSide >= 0n);
    assert.ok(settlement.dustResidualSide >= 0n);
  }
});

test("ct10: a stale mirror that underpays a crossed order reverts on the fill", () => {
  // The case CT-10 exists for, and the one the band cannot catch. The crossed
  // side is paid out of a pot fixed at the **mirror** price, while the band is
  // checked against `P0` on L1. A mirror above the real price shrinks the pot,
  // so a crossed order can be underpaid at a `P0` that is inside its band —
  // and the per-order check is the last line that stops it.
  const mirror = poolAt(3200n);
  const l1 = poolAt(3000n);
  const orders = [sellA(1, 10n * ONE, 0n), sellB(2, 3000n * ONE, (99n * ONE) / 100n)];

  const price = spotPriceX96(mirror.sqrtPriceX96);
  const leg = buildLeg(chargeFees(orders, PARAMS, price), price);
  // P0 is comfortably inside the band the orders set...
  const p0 = spotPriceX96(l1.sqrtPriceX96);
  assert.ok(p0 >= leg.minPriceX96 && p0 <= leg.maxPriceX96, "the band does not catch this");

  // ...and the fill is still below the limit, so the whole transaction reverts
  // and is poison-evicted for free.
  assert.throws(
    () => expectSettlement(orders, PARAMS, mirror, l1),
    (error: unknown) =>
      error instanceof SettlementRevert && error.reason === "LimitViolated" && error.orderId === id(2),
  );
});

test("ct1: a favourable move that breaks a crossed order's limit reverts on the band", () => {
  const mirror = poolAt(3000n);
  // The B side wants at least 1 A for 3000 B — satisfiable at the mirror. A
  // move *in the residual's favour* (the price rises) takes P0 past the
  // ceiling that order set, so the leg fails on the band rather than filling
  // the crossed order outside its limit.
  const orders = [sellA(1, 10n * ONE, 0n), sellB(2, 3000n * ONE, ONE)];
  const price = spotPriceX96(mirror.sqrtPriceX96);
  const leg = buildLeg(chargeFees(orders, PARAMS, price), price);

  const moved = poolAt(3600n);
  assert.throws(
    () => settleLeg(leg, moved),
    (error: unknown) =>
      error instanceof SettlementRevert &&
      error.reason === "ReferencePriceOutsideBand" &&
      error.bound === "max",
  );
});

test("ct6: a zero residual refreshes the mirror for one call and no swap", () => {
  const pool = poolAt(3000n);
  const price = spotPriceX96(pool.sqrtPriceX96);
  const orders = [sellA(1, 10n * ONE, 0n), sellB(2, 6000n * ONE, 0n)];
  const leg = buildLeg(chargeFees(orders, PARAMS, price), price);

  const refresh = settleLeg({ ...leg, residualIn: 0n }, pool);
  assert.equal(refresh.amountIn, 0n);
  assert.equal(refresh.amountOut, 0n);
  // There is no impact to bear, so the realised price is the reference price
  // and the pool is untouched — the mirror is the only thing that moves.
  assert.equal(refresh.executionPriceX96, refresh.referencePriceX96);
  assert.deepEqual(refresh.post, pool);
});

test("fl5: crossed orders clear at P0 and never pay impact", () => {
  const pool = poolAt(3000n);
  const orders = [sellA(1, 10n * ONE, 0n), sellB(2, 6000n * ONE, 0n)];
  const settlement = expectSettlement(orders, PARAMS, pool, pool);

  const crossed = settlement.fills.filter((fill) => fill.crossed);
  const residual = settlement.fills.filter((fill) => !fill.crossed);
  assert.ok(crossed.length > 0 && residual.length > 0);

  for (const fill of crossed) {
    assert.equal(fill.impactAmount, 0n, "a crossed order never pays impact");
    const order = settlement.charged.orders.find((entry) => entry.id === fill.id);
    assert.ok(order !== undefined);
    // The crossed side is paid out of the pot fixed at the mirror price, so
    // its realised price is that price to the rounding of one division.
    const realised = order.sideIsA
      ? mulDiv(fill.amountOut, Q96, order.netIn)
      : mulDiv(order.netIn, Q96, fill.amountOut);
    const p0 = settlement.result.referencePriceX96;
    const drift = realised > p0 ? realised - p0 : p0 - realised;
    assert.ok(drift * 1_000_000_000n <= p0, `crossed fill cleared at ${realised}, not ${p0}`);
  }
  for (const fill of residual) {
    assert.ok(fill.impactAmount > 0n, "the residual side pays the swap's impact");
  }
});

test("sv2: selection is identical across permutations of the input", () => {
  const pool = poolAt(3000n);
  const orders = [
    sellA(1, 10n * ONE, 29_000n * ONE),
    sellA(2, 5n * ONE, 15_100n * ONE),
    sellB(3, 9000n * ONE, 2n * ONE),
    sellB(4, 30_000n * ONE, 11n * ONE),
    sellA(5, 1n * ONE, 0n),
  ];
  const baseline = selectFillable(orders, PARAMS, pool, pool).selected.map((order) => order.id);

  const rng = new Rng(7n);
  for (let round = 0; round < 20; round += 1) {
    const permuted = rng.shuffle([...orders]);
    const selected = selectFillable(permuted, PARAMS, pool, pool).selected.map((order) => order.id);
    assert.deepEqual(selected, baseline, `permutation ${round} selected a different set`);
  }
});

test("fl8: the selection is inclusion-maximal and never violates a limit", () => {
  const pool = poolAt(3000n);
  const orders = [
    sellA(1, 10n * ONE, 29_900n * ONE),
    sellA(2, 5n * ONE, 15_100n * ONE),
    sellB(3, 9000n * ONE, 2n * ONE),
    sellB(4, 30_000n * ONE, 11n * ONE),
  ];
  const { selected, dropped } = selectFillable(orders, PARAMS, pool, pool);

  if (selected.length > 0) assert.ok(settles(selected, PARAMS, pool, pool));
  for (const candidate of dropped) {
    assert.ok(
      !settles([...selected, candidate], PARAMS, pool, pool),
      `${candidate.id} could have been added: the selection is not inclusion-maximal`,
    );
  }
  assert.deepEqual(omittedFillable(selected, dropped, PARAMS, pool, pool), []);
});

test("ec4: the audit names a fillable order a settlement left out", () => {
  const pool = poolAt(3000n);
  const settled = [sellA(1, 10n * ONE, 0n)];
  const left = [sellB(2, 3000n * ONE, 0n)];
  // Nothing about that B-side order stops it settling alongside the A side, so
  // leaving it out is exactly the omission `selection_omitted_total` counts.
  assert.deepEqual(omittedFillable(settled, left, PARAMS, pool, pool), [id(2)]);
});

test("fl7: a selection with an empty band reverts before any L1 call", () => {
  const pool = poolAt(3000n);
  // An A-side order demanding better than 3100 and a B-side order demanding
  // better than 1/2900: no single price satisfies both.
  const orders = [sellA(1, 10n * ONE, 31_000n * ONE), sellB(2, 29_000n * ONE, 10n * ONE)];
  assert.throws(
    () => buildLeg(chargeFees(orders, PARAMS, spotPriceX96(pool.sqrtPriceX96)), spotPriceX96(pool.sqrtPriceX96)),
    (error: unknown) => error instanceof SettlementRevert && error.reason === "EmptyPriceBand",
  );
});
