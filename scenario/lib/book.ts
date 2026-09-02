/**
 * `WindowBook` and `SettlementRouter`, as an oracle — RD-2 CT-1, CT-9 … CT-12.
 *
 * The scenario asserts on a settlement by recomputing it: the fees, the cross
 * and residual, the price band, the L1 leg against `MockPool`'s curve, and
 * every fill. If the recomputation and the chain disagree, one of them is
 * wrong and the run fails — which is the only way an assertion like "every
 * crossed order filled at `referencePriceX96`" means anything. Reading the
 * numbers back out of the events and checking they are self-consistent would
 * pass against a contract that had quietly changed its mind.
 *
 * It is deliberately a *second implementation*: it follows RD-2's text, not
 * `WindowBook.sol`'s control flow, so a transcription error is unlikely to be
 * the same transcription error.
 */

import { Q96, mulDiv, mulDivCeil, spotPriceX96 } from "./math.ts";
import type { Pool } from "./pool.ts";
import { swap } from "./pool.ts";
import type { Side } from "../../indexer/schema/index.ts";

/** EC-1's two fee shapes. */
export type FeeMode = "bps" | "fixed";

/** EC-1's route-fee models. `absorb` is the launch default. */
export type RouteFeeModel = "absorb" | "recover";

/** The book's configuration, as far as settlement arithmetic cares. */
export interface BookParams {
  readonly feeMode: FeeMode;
  /** `FEE_BPS`. EC-1 caps it at 1 bp at 2026 gas. */
  readonly feeBps: bigint;
  /** `FEE_FIXED` in A's units. */
  readonly feeFixedA: bigint;
  /** `FEE_FIXED` in B's units. */
  readonly feeFixedB: bigint;
  readonly routeFeeModel: RouteFeeModel;
  /** The window's route fee in wei, split pro-rata when `recover` (CT-12). */
  readonly routeFeeWei: bigint;
  /** True when A is the rail's native asset — which side a wei converts through. */
  readonly assetAIsNative: boolean;
}

/** One order, as the book holds it. */
export interface BookOrder {
  readonly id: string;
  readonly side: Side;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
}

/** One order after fees, as `Selection` carries it. */
export interface ChargedOrder extends BookOrder {
  readonly fee: bigint;
  readonly routeFee: bigint;
  readonly netIn: bigint;
  readonly sideIsA: boolean;
}

/** A charged selection and its two sums. */
export interface Charged {
  readonly orders: readonly ChargedOrder[];
  /** Σ `netIn` on the A side. */
  readonly sumA: bigint;
  /** Σ `netIn` on the B side. */
  readonly sumB: bigint;
}

/** The leg the contract builds, plus what the split implies for the fills. */
export interface BuiltLeg {
  readonly residualIsA: boolean;
  readonly residualSide: Side;
  /** What the crossed side collectively receives, in its buy asset. */
  readonly crossPot: bigint;
  readonly residualIn: bigint;
  readonly minPriceX96: bigint;
  readonly maxPriceX96: bigint;
}

/** The leg's return (A.1). */
export interface LegResult {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly referencePriceX96: bigint;
  readonly executionPriceX96: bigint;
  readonly post: Pool;
}

/** One order's fill, as `_applyResult` computes it. */
export interface ExpectedFill {
  readonly id: string;
  readonly amountOut: bigint;
  readonly feeAmount: bigint;
  readonly routeFeeAmount: bigint;
  readonly impactAmount: bigint;
  readonly crossed: boolean;
}

/** Every way a window can fail to settle, by the contract's own error names. */
export class SettlementRevert extends Error {
  readonly reason: string;
  /** The order at fault, where exactly one is. */
  readonly orderId: string | null;
  /** The end of the band a price left, where the failure names one. */
  readonly bound: BandBound | null;

  constructor(
    reason: string,
    message: string,
    orderId: string | null = null,
    bound: BandBound | null = null,
  ) {
    super(message);
    this.name = "SettlementRevert";
    this.reason = reason;
    this.orderId = orderId;
    this.bound = bound;
  }
}

/** EC-1's two shapes, both in the sell asset (CT-12). */
export function protocolFee(params: BookParams, sellAmount: bigint, sideIsA: boolean): bigint {
  if (params.feeMode === "bps") return mulDiv(sellAmount, params.feeBps, 10_000n);
  return sideIsA ? params.feeFixedA : params.feeFixedB;
}

/**
 * `_chargeFees`. With `ROUTE_FEE_MODEL=absorb` — the launch setting, and what
 * the scenario runs — the route fee is zero on every order and the protocol
 * carries the leg's gas (EC-1).
 */
export function chargeFees(
  orders: readonly BookOrder[],
  params: BookParams,
  mirrorPriceX96: bigint,
): Charged {
  let notionalTotal = 0n;
  const notional: bigint[] = [];
  const recovering = params.routeFeeModel === "recover" && params.routeFeeWei !== 0n;
  if (recovering) {
    for (const order of orders) {
      const sideIsA = order.side === "SELL_A_FOR_B";
      const value = sideIsA ? order.sellAmount : mulDiv(order.sellAmount, Q96, mirrorPriceX96);
      notional.push(value);
      notionalTotal += value;
    }
  }

  const charged: ChargedOrder[] = [];
  let sumA = 0n;
  let sumB = 0n;

  orders.forEach((order, index) => {
    const sideIsA = order.side === "SELL_A_FOR_B";
    const fee = protocolFee(params, order.sellAmount, sideIsA);
    let routeFee = 0n;
    if (notionalTotal !== 0n) {
      const share = mulDiv(params.routeFeeWei, notional[index] ?? 0n, notionalTotal);
      routeFee = routeFeeInSellAsset(params, share, sideIsA, mirrorPriceX96);
    }
    if (fee + routeFee >= order.sellAmount) {
      throw new SettlementRevert("FeeExceedsOrder", `fees exceed order ${order.id}`, order.id);
    }
    const netIn = order.sellAmount - fee - routeFee;
    if (sideIsA) sumA += netIn;
    else sumB += netIn;
    charged.push({ ...order, fee, routeFee, netIn, sideIsA });
  });

  return { orders: charged, sumA, sumB };
}

/** `_routeFeeInSellAsset`: wei, converted through the pair's ETH leg. */
function routeFeeInSellAsset(
  params: BookParams,
  amountWei: bigint,
  sideIsA: boolean,
  mirrorPriceX96: bigint,
): bigint {
  const sellIsNative = sideIsA === params.assetAIsNative;
  if (sellIsNative) return amountWei;
  return sideIsA ? mulDiv(amountWei, Q96, mirrorPriceX96) : mulDiv(amountWei, mirrorPriceX96, Q96);
}

/**
 * `_buildLeg`: FL-4's cross and residual at the **mirror** price, then CT-9's
 * band.
 *
 * The crossed volume is fixed here, before the L1 call, because `residualIn`
 * is: the two are one number seen from opposite sides. The only price
 * available at that moment is the mirror's, which is why the residual side
 * carries the whole difference between it and the `P0` the leg returns.
 */
export function buildLeg(charged: Charged, mirrorPriceX96: bigint): BuiltLeg {
  const sumBinA = charged.sumB === 0n ? 0n : mulDiv(charged.sumB, Q96, mirrorPriceX96);
  let residualIsA: boolean;
  let crossPot: bigint;
  let residualIn: bigint;

  if (charged.sumA >= sumBinA) {
    residualIsA = true;
    crossPot = sumBinA;
    residualIn = charged.sumA - sumBinA;
  } else {
    residualIsA = false;
    crossPot = mulDiv(charged.sumA, mirrorPriceX96, Q96);
    residualIn = charged.sumB - crossPot;
  }

  if (residualIn === 0n && crossPot === 0n) {
    throw new SettlementRevert("NothingToSettle", "the selection crosses nothing and swaps nothing");
  }

  const { minPriceX96, maxPriceX96 } = priceBand(charged.orders);
  if (minPriceX96 > maxPriceX96) {
    throw new SettlementRevert(
      "EmptyPriceBand",
      `no price satisfies every selected order (${minPriceX96} > ${maxPriceX96})`,
      null,
      null,
    );
  }

  return {
    residualIsA,
    residualSide: residualIsA ? "SELL_A_FOR_B" : "SELL_B_FOR_A",
    crossPot,
    residualIn,
    minPriceX96,
    maxPriceX96,
  };
}

/** Which bound of the band an order sets. */
export type BandBound = "min" | "max";

/**
 * `_priceBand`: the tightest sell-side limit and the tightest buy-side limit
 * among the selected orders, each derived from `netIn` so the bound demands
 * the price that leaves the user their limit *after* fees.
 */
export function priceBand(orders: readonly ChargedOrder[]): {
  minPriceX96: bigint;
  maxPriceX96: bigint;
} {
  let minPriceX96 = 0n;
  let maxPriceX96 = (1n << 256n) - 1n;
  for (const order of orders) {
    if (order.minBuyAmount === 0n) continue;
    if (order.sideIsA) {
      const bound = mulDivCeil(order.minBuyAmount, Q96, order.netIn);
      if (bound > minPriceX96) minPriceX96 = bound;
    } else {
      const bound = mulDiv(order.netIn, Q96, order.minBuyAmount);
      if (bound < maxPriceX96) maxPriceX96 = bound;
    }
  }
  return { minPriceX96, maxPriceX96 };
}

/** The orders that set one end of the band — the ones a drop would relieve. */
export function bindingOrders(orders: readonly ChargedOrder[], bound: BandBound): string[] {
  const band = priceBand(orders);
  const ids: string[] = [];
  for (const order of orders) {
    if (order.minBuyAmount === 0n) continue;
    if (bound === "min" && order.sideIsA && mulDivCeil(order.minBuyAmount, Q96, order.netIn) === band.minPriceX96) {
      ids.push(order.id);
    }
    if (bound === "max" && !order.sideIsA && mulDiv(order.netIn, Q96, order.minBuyAmount) === band.maxPriceX96) {
      ids.push(order.id);
    }
  }
  return ids.sort();
}

/**
 * `SettlementRouter._settleLeg` against a pool snapshot: the deadline, `P0`
 * against the band, the swap, and the realised price against the band — CT-1's
 * order of checks, and the reason a favourable move that breaks a crossed
 * order's limit fails for free rather than filling it outside its limit.
 */
export function settleLeg(leg: BuiltLeg, pool: Pool): LegResult {
  const referencePriceX96 = spotPriceX96(pool.sqrtPriceX96);
  if (referencePriceX96 < leg.minPriceX96 || referencePriceX96 > leg.maxPriceX96) {
    throw new SettlementRevert(
      "ReferencePriceOutsideBand",
      `P0 ${referencePriceX96} is outside [${leg.minPriceX96}, ${leg.maxPriceX96}]`,
      null,
      referencePriceX96 < leg.minPriceX96 ? "min" : "max",
    );
  }

  // CT-6: a quiet window refreshes the mirror for one call and no swap.
  if (leg.residualIn === 0n) {
    return {
      amountIn: 0n,
      amountOut: 0n,
      referencePriceX96,
      executionPriceX96: referencePriceX96,
      post: pool,
    };
  }

  const result = swap(pool, leg.residualIsA, leg.residualIn);
  const executionPriceX96 = leg.residualIsA
    ? mulDiv(result.amountOut, Q96, leg.residualIn)
    : mulDiv(leg.residualIn, Q96, result.amountOut);
  if (executionPriceX96 < leg.minPriceX96 || executionPriceX96 > leg.maxPriceX96) {
    throw new SettlementRevert(
      "ExecutionPriceOutsideBand",
      `the realised price ${executionPriceX96} is outside [${leg.minPriceX96}, ${leg.maxPriceX96}]`,
      null,
      executionPriceX96 < leg.minPriceX96 ? "min" : "max",
    );
  }

  return {
    amountIn: leg.residualIn,
    amountOut: result.amountOut,
    referencePriceX96,
    executionPriceX96,
    post: result.pool,
  };
}

/**
 * `_applyResult` and `_fill`: crossed orders out of the pot fixed at build
 * time, residual-side orders out of that side's escrow plus the leg's output,
 * every one of them checked against its limit (CT-10). The first violation
 * throws, because on-chain it reverts the whole transaction.
 */
export function applyResult(charged: Charged, leg: BuiltLeg, result: LegResult): ExpectedFill[] {
  const p0 = result.referencePriceX96;
  if (p0 === 0n) throw new SettlementRevert("MalformedResult", "the leg returned a zero reference price");

  const residualPot = (leg.residualIsA ? charged.sumB : charged.sumA) + result.amountOut;
  const residualSum = leg.residualIsA ? charged.sumA : charged.sumB;
  const crossedSum = leg.residualIsA ? charged.sumB : charged.sumA;

  const fills: ExpectedFill[] = [];
  for (const order of charged.orders) {
    const isResidual = order.sideIsA === leg.residualIsA;
    const amountOut = isResidual
      ? mulDiv(residualPot, order.netIn, residualSum)
      : mulDiv(leg.crossPot, order.netIn, crossedSum);
    if (amountOut < order.minBuyAmount) {
      throw new SettlementRevert(
        "LimitViolated",
        `order ${order.id} would fill at ${amountOut}, below its limit ${order.minBuyAmount}`,
        order.id,
      );
    }
    fills.push({
      id: order.id,
      amountOut,
      feeAmount: order.fee,
      routeFeeAmount: order.routeFee,
      impactAmount: isResidual ? impactOf(order, amountOut, p0) : 0n,
      crossed: !isResidual,
    });
  }
  return fills;
}

/** `_impact`: the part of a residual-side input that bought nothing at `P0`. */
function impactOf(order: ChargedOrder, amountOut: bigint, p0: bigint): bigint {
  const inputAtP0 = order.sideIsA ? mulDiv(amountOut, Q96, p0) : mulDiv(amountOut, p0, Q96);
  return order.netIn > inputAtP0 ? order.netIn - inputAtP0 : 0n;
}

/** A whole window, recomputed: fees, leg, L1, fills. */
export interface ExpectedSettlement {
  readonly charged: Charged;
  readonly leg: BuiltLeg;
  readonly result: LegResult;
  readonly fills: readonly ExpectedFill[];
  /** The dust CT-12 leaves in the fee bucket, per side. */
  readonly dustResidualSide: bigint;
  readonly dustCrossedSide: bigint;
}

/**
 * What a settlement of `orders` against `pool` should produce. Throws a
 * {@link SettlementRevert} where the chain would revert, with the same reason
 * name — which is what lets a failure-matrix row assert *why* a window failed
 * rather than only that it did.
 */
export function expectSettlement(
  orders: readonly BookOrder[],
  params: BookParams,
  mirror: Pool,
  l1Pool: Pool,
): ExpectedSettlement {
  const mirrorPriceX96 = spotPriceX96(mirror.sqrtPriceX96);
  const charged = chargeFees(orders, params, mirrorPriceX96);
  const leg = buildLeg(charged, mirrorPriceX96);
  const result = settleLeg(leg, l1Pool);
  const fills = applyResult(charged, leg, result);

  const residualPot = (leg.residualIsA ? charged.sumB : charged.sumA) + result.amountOut;
  let residualPaid = 0n;
  let crossPaid = 0n;
  for (const fill of fills) {
    if (fill.crossed) crossPaid += fill.amountOut;
    else residualPaid += fill.amountOut;
  }

  return {
    charged,
    leg,
    result,
    fills,
    dustResidualSide: residualPot - residualPaid,
    dustCrossedSide: leg.crossPot - crossPaid,
  };
}

/**
 * Whether a selection settles at all — the predicate the inclusion-maximality
 * audit is built on (FL-8, EC-4). A settlement the contract would revert is
 * not a selection the settler could have submitted.
 */
export function settles(
  orders: readonly BookOrder[],
  params: BookParams,
  mirror: Pool,
  l1Pool: Pool,
): boolean {
  try {
    expectSettlement(orders, params, mirror, l1Pool);
    return true;
  } catch (error) {
    if (error instanceof SettlementRevert) return false;
    throw error;
  }
}

/**
 * FL-8's limit selection to a fixed point, and SV-2's determinism — the
 * settler's job, redone here so the harness can audit it (EC-4).
 *
 * Drop phase: while the set does not settle, remove the lowest-id order that
 * could relieve the failure. Re-add phase: a drop can relax the band enough
 * that an earlier casualty fits again, so the fixed point is only reached when
 * a whole ascending pass adds nothing. That second phase is what makes the
 * result **inclusion-maximal** rather than merely feasible, and it is the
 * property `selection_omitted_total` measures the settler against.
 *
 * Nothing here reads a clock or a map's iteration order: the candidate list is
 * sorted by id, drops take the lowest id, and re-additions are tried in
 * ascending id order, so two runs over the same inputs select the same set.
 */
export function selectFillable(
  candidates: readonly BookOrder[],
  params: BookParams,
  mirror: Pool,
  l1Pool: Pool,
): { selected: BookOrder[]; dropped: BookOrder[] } {
  const byId = (a: BookOrder, b: BookOrder): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...candidates].sort(byId);
  let kept = [...sorted];

  while (kept.length > 0) {
    const target = dropTarget(kept, params, mirror, l1Pool);
    if (target === undefined) break;
    if (target === null) {
      kept = [];
      break;
    }
    kept = kept.filter((order) => order.id !== target);
  }

  for (;;) {
    let added = false;
    for (const candidate of sorted) {
      if (kept.some((order) => order.id === candidate.id)) continue;
      const trial = [...kept, candidate].sort(byId);
      if (!settles(trial, params, mirror, l1Pool)) continue;
      kept = trial;
      added = true;
    }
    if (!added) break;
  }

  kept.sort(byId);
  const keptIds = new Set(kept.map((order) => order.id));
  return { selected: kept, dropped: sorted.filter((order) => !keptIds.has(order.id)) };
}

/**
 * The order to drop, or `undefined` when the set already settles and `null`
 * when nothing identifiable would relieve the failure — a structural revert is
 * not one order's fault, and dropping an arbitrary order to chase it would be
 * guessing.
 */
function dropTarget(
  orders: readonly BookOrder[],
  params: BookParams,
  mirror: Pool,
  l1Pool: Pool,
): string | null | undefined {
  try {
    expectSettlement(orders, params, mirror, l1Pool);
    return undefined;
  } catch (error) {
    if (!(error instanceof SettlementRevert)) throw error;
    if (error.orderId !== null) return error.orderId;

    const mirrorPriceX96 = spotPriceX96(mirror.sqrtPriceX96);
    let charged: Charged;
    try {
      charged = chargeFees(orders, params, mirrorPriceX96);
    } catch {
      return null;
    }

    if (error.bound !== null) return bindingOrders(charged.orders, error.bound)[0] ?? null;
    if (error.reason === "EmptyPriceBand") {
      const both = [...bindingOrders(charged.orders, "min"), ...bindingOrders(charged.orders, "max")].sort();
      return both[0] ?? null;
    }
    return null;
  }
}

/**
 * EC-4's selection audit: the fillable orders a settlement left out.
 *
 * Recomputed from the settled selection and the pool state the leg read, which
 * is what makes it independent of the settler. A non-empty result is
 * `selection_omitted_total`, and A.5 says that must be zero.
 */
export function omittedFillable(
  settled: readonly BookOrder[],
  stillOpen: readonly BookOrder[],
  params: BookParams,
  mirror: Pool,
  l1Pool: Pool,
): string[] {
  const omitted: string[] = [];
  for (const candidate of [...stillOpen].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (settled.some((order) => order.id === candidate.id)) continue;
    if (settles([...settled, candidate], params, mirror, l1Pool)) omitted.push(candidate.id);
  }
  return omitted;
}
