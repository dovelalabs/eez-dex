/**
 * Appendix A.6's assertions — RD-2 HX-2, HX-3, HX-4, §10.
 *
 * Every check below reads the recorded run (what the chain said) and the
 * readings the harness took off the chain (what the chain *is*), and compares
 * both against {@link ./book.ts}'s recomputation of what should have happened.
 * Three sources, one answer, or the run fails.
 *
 * Each check names the requirement it pins, because a failing line in a CI log
 * should say which sentence of RD-2 stopped being true.
 */

import type { Order, PoolState, Settlement, SlotEvent, Window } from "../../indexer/schema/index.ts";
import type { BookOrder, BookParams } from "./book.ts";
import { expectSettlement, omittedFillable } from "./book.ts";
import { absDiff, fromBig, toBig } from "./math.ts";
import type { Pool } from "./pool.ts";
import { summarise } from "./record.ts";

/** One asset's CT-13 ledger, read at an L2 safe head. */
export interface EscrowLedger {
  readonly asset: string;
  readonly escrowed: string;
  readonly feesAccrued: string;
  readonly dustAccrued: string;
  readonly credited: string;
  readonly deposits: string;
  readonly released: string;
  readonly withdrawn: string;
  /** `escrowInvariantDrift(asset)` as the book reports it. Must be `"0"`. */
  readonly drift: string;
}

/** What the bundle carried in the slot the settlement rode in (EC-5). */
export interface BundleReading {
  readonly l1Block: number;
  /** Cross-layer transactions in the bundle, of every product. */
  readonly crossLayerTxs: number;
  /** How many of them were this DEX's. */
  readonly dexTxs: number;
  /** `MAX_USER_TXS_PER_BUNDLE`, matching the node's env (EC-5). */
  readonly cap: number;
}

/** A recipient's balance after the run — L2 [full], L1 [genesis]. */
export interface BalanceReading {
  readonly asset: string;
  readonly owner: string;
  readonly amount: string;
}

/** What the harness expects of this particular run. */
export interface Expectation {
  /** Which A.6 section is being asserted. */
  readonly mode: "happy" | "matrix" | "soak";
  /** HX-2: `fills_per_settlement == 8`. */
  readonly fillsPerSettlement?: number;
  /** HX-2: exactly one cross-layer transaction settled them. */
  readonly settlements?: number;
  /** HX-4: every order reaches a terminal state. */
  readonly allOrdersTerminal?: boolean;
}

/** Everything the harness read off the chain, to assert the run against. */
export interface Readings {
  readonly profile: "full" | "genesis";
  readonly params: {
    readonly feeMode: string;
    readonly feeBps: string;
    readonly feeFixedA: string;
    readonly feeFixedB: string;
    readonly routeFeeModel: string;
    readonly routeFeeWei: string;
    readonly assetAIsNative: string;
  };
  /** The pool's fee tier, in hundredths of a bip. */
  readonly poolFee: string;
  /** The book's stored mirror at the end of the run. */
  readonly mirror: PoolState;
  /** `MockPool`'s live state on L1 at the same point. */
  readonly poolL1: PoolState;
  readonly escrow: readonly EscrowLedger[];
  readonly balances: readonly BalanceReading[];
  /** Orders still open in the book, for the inclusion-maximality audit. */
  readonly openOrders: readonly {
    readonly id: string;
    readonly side: string;
    readonly sellAmount: string;
    readonly minBuyAmount: string;
  }[];
  /**
   * What each settlement's leg was built against, as the harness watched it:
   * the book's mirror in the block before the Sync block, and `MockPool`'s
   * state at the L1 head the leg read. Recorded rather than inverted out of
   * the result — a reconstruction would make the oracle agree with the chain
   * by construction, which is the one thing it must not do.
   */
  readonly legInputs?: readonly {
    readonly settlementId: string;
    readonly mirror: PoolState;
    readonly pool: PoolState;
  }[];
  readonly bundle?: BundleReading;
  readonly expect: Expectation;
}

/** A collected set of named checks, each citing what it pins. */
export class Checks {
  readonly lines: string[] = [];
  failures = 0;
  private passes = 0;

  ok(requirement: string, what: string): void {
    this.passes += 1;
    this.lines.push(`  PASS  ${requirement.padEnd(6)} ${what}`);
  }

  bad(requirement: string, what: string, detail: string): void {
    this.failures += 1;
    this.lines.push(`  FAIL  ${requirement.padEnd(6)} ${what}\n          ${detail}`);
  }

  that(requirement: string, what: string, condition: boolean, detail = ""): void {
    if (condition) this.ok(requirement, what);
    else this.bad(requirement, what, detail);
  }

  equal(requirement: string, what: string, actual: unknown, expected: unknown): void {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    this.that(requirement, what, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  /**
   * A measurement the run is required to *report* rather than pass or fail —
   * HX-4's amortisation metrics and `roll_rate`. It is not counted as a check,
   * because a number nobody set a threshold on cannot be one.
   */
  note(requirement: string, what: string): void {
    this.lines.push(`  ....  ${requirement.padEnd(6)} ${what}`);
  }

  /** The closing summary line, and the exit status the shell reads. */
  summary(title: string): { lines: string[]; failures: number } {
    const total = this.passes + this.failures;
    this.lines.push(
      this.failures === 0
        ? `==> ${title}: ${total} checks passed`
        : `==> ${title}: ${this.failures} of ${total} checks FAILED`,
    );
    return { lines: this.lines, failures: this.failures };
  }
}

/** The final state of every object the run touched. */
export interface RunState {
  readonly windows: Map<string, Window>;
  readonly orders: Map<string, Order>;
  readonly settlements: Map<string, Settlement>;
  readonly metrics: Record<string, number>;
}

/** Folds a recorded run into the last thing it said about each object. */
export function stateOf(events: readonly SlotEvent[]): RunState {
  const windows = new Map<string, Window>();
  const orders = new Map<string, Order>();
  const settlements = new Map<string, Settlement>();
  for (const event of events) {
    if (event.kind === "window") windows.set(event.window.windowId, event.window);
    if (event.kind === "order") orders.set(event.order.id, event.order);
    if (event.kind === "settlement") settlements.set(event.settlement.id, event.settlement);
  }
  return { windows, orders, settlements, metrics: summarise(events).snapshot() };
}

function poolOf(state: PoolState, fee: bigint): Pool {
  return { sqrtPriceX96: toBig(state.sqrtPriceX96), liquidity: toBig(state.liquidity), fee };
}

function paramsOf(readings: Readings): BookParams {
  return {
    feeMode: readings.params.feeMode === "fixed" ? "fixed" : "bps",
    feeBps: toBig(readings.params.feeBps),
    feeFixedA: toBig(readings.params.feeFixedA),
    feeFixedB: toBig(readings.params.feeFixedB),
    routeFeeModel: readings.params.routeFeeModel === "recover" ? "recover" : "absorb",
    routeFeeWei: toBig(readings.params.routeFeeWei),
    assetAIsNative: readings.params.assetAIsNative !== "false",
  };
}

/**
 * CT-13, per asset, to the wei:
 * `Σ escrow + Σ fees + Σ dust + Σ credited == Σ deposits − Σ released − Σ withdrawn`.
 *
 * The book publishes its own `escrowInvariantDrift`, and the harness both
 * checks that it reads zero *and* recomputes the identity from the ledger
 * components — a drift function that returned zero unconditionally would pass
 * the first and fail the second.
 */
export function checkEscrowInvariant(checks: Checks, readings: Readings): void {
  for (const ledger of readings.escrow) {
    const held =
      toBig(ledger.escrowed) + toBig(ledger.feesAccrued) + toBig(ledger.dustAccrued) + toBig(ledger.credited);
    const net = toBig(ledger.deposits) - toBig(ledger.released) - toBig(ledger.withdrawn);
    checks.that(
      "CT-13",
      `the escrow invariant holds to the wei for ${ledger.asset}`,
      held === net,
      `escrow+fees+dust+credited = ${held}, deposits-released-withdrawn = ${net}, drift ${held - net}`,
    );
    checks.equal("CT-13", `escrow_invariant_drift_wei is zero for ${ledger.asset}`, ledger.drift, "0");
  }
}

/** The mirror is the pool: A.6's "MockPool state on L1 equals the stored mirror". */
export function checkMirrorEqualsPool(checks: Checks, readings: Readings): void {
  checks.equal("FL-1", "the stored mirror equals MockPool's state on L1", readings.mirror, readings.poolL1);
}

/**
 * CT-10, everywhere: no fill in the run is below its order's limit. This is
 * §10's "nobody is filled outside their limit", and it is asserted over the
 * whole run rather than per row, because the claim is universal.
 */
export function checkNoFillBelowLimit(checks: Checks, state: RunState): void {
  const violations: string[] = [];
  for (const order of state.orders.values()) {
    if (order.fill === null) continue;
    if (toBig(order.fill.amountOut) < toBig(order.minBuyAmount)) {
      violations.push(`${order.id}: filled ${order.fill.amountOut} against a limit of ${order.minBuyAmount}`);
    }
  }
  checks.that("CT-10", "no fill in the run is below its order's limit", violations.length === 0, violations.join("; "));
}

/**
 * FL-5, per settlement: every crossed order cleared at `referencePriceX96` and
 * every residual-side order at that price less its own impact share.
 */
export function checkClearingPrices(checks: Checks, state: RunState): void {
  for (const settlement of state.settlements.values()) {
    if (settlement.outcome !== "settled" || settlement.result === null) continue;
    const p0 = toBig(settlement.result.referencePriceX96);

    let crossed = 0;
    let residual = 0;
    const problems: string[] = [];
    for (const id of settlement.filledOrderIds) {
      const order = state.orders.get(id);
      if (order?.fill == null) continue;
      const price = toBig(order.fill.priceX96);
      if (order.fill.crossed) {
        crossed += 1;
        if (price !== p0) problems.push(`${id} crossed at ${price}, not ${p0}`);
        if (toBig(order.fill.impactAmount) !== 0n) problems.push(`${id} crossed but paid impact`);
      } else {
        residual += 1;
        // Prices are B per A whichever way the order trades, so "worse than
        // P0" points in opposite directions on the two sides: an A-side seller
        // gets fewer B per A, a B-side seller pays more B per A. The residual
        // side always pays the impact and never receives it.
        //
        // The tolerance is CT-12's rounding, not slack in the rule. The
        // crossed pot is floored when the leg is built, and the remainder —
        // under one unit of the crossed asset — is redistributed across the
        // residual pot, which can move this order's realised price by at most
        // `P0 / netIn`. Anything larger is the residual side being paid a
        // windfall, which is the thing FL-5 exists to prevent.
        const netIn =
          toBig(order.sellAmount) - toBig(order.fill.feeAmount) - toBig(order.fill.routeFeeAmount);
        const rounding = netIn === 0n ? 0n : p0 / netIn + 1n;
        const worse =
          settlement.leg.residualSide === "SELL_A_FOR_B" ? price <= p0 + rounding : price + rounding >= p0;
        if (!worse) {
          problems.push(`${id} was on the residual side yet cleared better than P0 (${price} vs ${p0})`);
        }
      }
    }
    checks.that(
      "FL-5",
      `window ${settlement.windowId}: ${crossed} crossed at P0, ${residual} residual-side paid the impact`,
      problems.length === 0,
      problems.join("; "),
    );
  }
}

/** CT-9: `WindowSettled`'s `amountIn` is the residual the contract built. */
export function checkResidualMatchesLeg(checks: Checks, state: RunState): void {
  for (const settlement of state.settlements.values()) {
    if (settlement.outcome !== "settled" || settlement.result === null) continue;
    checks.equal(
      "CT-9",
      `window ${settlement.windowId}: WindowSettled amountIn equals the on-chain residual`,
      settlement.result.amountIn,
      settlement.leg.residualIn,
    );
  }
}

/**
 * The oracle, applied: each settled window is recomputed from its fills'
 * inputs and the two states the harness watched the leg being built against,
 * and every fill must match to the wei.
 *
 * A window with no recorded leg inputs is reported rather than skipped
 * quietly: an assertion that silently checks nothing is worse than one that
 * fails.
 */
export function checkAgainstOracle(checks: Checks, state: RunState, readings: Readings): void {
  const params = paramsOf(readings);
  const poolFee = toBig(readings.poolFee);
  const inputs = new Map((readings.legInputs ?? []).map((entry) => [entry.settlementId, entry]));

  for (const settlement of state.settlements.values()) {
    if (settlement.outcome !== "settled" || settlement.result === null) continue;
    const orders: BookOrder[] = [];
    for (const id of settlement.filledOrderIds) {
      const order = state.orders.get(id);
      if (order === undefined) continue;
      orders.push({
        id: order.id,
        side: order.side,
        sellAmount: toBig(order.sellAmount),
        minBuyAmount: toBig(order.minBuyAmount),
      });
    }
    if (orders.length === 0) continue;

    const observed = inputs.get(settlement.id);
    if (observed === undefined) {
      checks.bad(
        "CT-12",
        `window ${settlement.windowId}: the leg's inputs were not recorded, so nothing was recomputed`,
        `no legInputs entry for settlement ${settlement.id}`,
      );
      continue;
    }

    try {
      const expected = expectSettlement(
        orders,
        params,
        poolOf(observed.mirror, poolFee),
        poolOf(observed.pool, poolFee),
      );
      const problems: string[] = [];
      if (expected.leg.residualIn !== toBig(settlement.leg.residualIn)) {
        problems.push(`residualIn ${settlement.leg.residualIn}, the oracle says ${expected.leg.residualIn}`);
      }
      if (expected.result.referencePriceX96 !== toBig(settlement.result.referencePriceX96)) {
        problems.push(
          `P0 ${settlement.result.referencePriceX96}, the oracle says ${expected.result.referencePriceX96}`,
        );
      }
      for (const fill of expected.fills) {
        const actual = state.orders.get(fill.id)?.fill;
        if (actual == null) {
          problems.push(`${fill.id} has no fill`);
          continue;
        }
        if (toBig(actual.amountOut) !== fill.amountOut) {
          problems.push(`${fill.id}: filled ${actual.amountOut}, the oracle says ${fill.amountOut}`);
        }
        if (toBig(actual.impactAmount) !== fill.impactAmount) {
          problems.push(`${fill.id}: impact ${actual.impactAmount}, the oracle says ${fill.impactAmount}`);
        }
        if (actual.crossed !== fill.crossed) problems.push(`${fill.id}: crossed disagrees with the oracle`);
      }
      checks.that(
        "CT-12",
        `window ${settlement.windowId}: the whole settlement matches the oracle to the wei`,
        problems.length === 0,
        problems.join("; "),
      );
    } catch (error) {
      checks.bad(
        "CT-12",
        `window ${settlement.windowId}: the oracle could not reproduce the settlement`,
        (error as Error).message,
      );
    }
  }
}

/** EC-4: the settler left no fillable order out (`selection_omitted_total`). */
export function checkSelectionAudit(checks: Checks, state: RunState, readings: Readings): void {
  const settled = [...state.settlements.values()].filter(
    (settlement) => settlement.outcome === "settled" && settlement.result !== null,
  );
  const last = settled[settled.length - 1];
  if (last === undefined || last.result === null) {
    checks.that("EC-4", "there is a settlement to audit the selection of", settled.length > 0, "no window settled");
    return;
  }

  const params = paramsOf(readings);
  const observed = (readings.legInputs ?? []).find((entry) => entry.settlementId === last.id);
  if (observed === undefined) {
    checks.bad("EC-4", "the selection audit needs the leg's recorded inputs", `no legInputs for ${last.id}`);
    return;
  }
  const pool = poolOf(observed.pool, toBig(readings.poolFee));
  const mirror = poolOf(observed.mirror, toBig(readings.poolFee));
  const inSettlement: BookOrder[] = [];
  for (const id of last.filledOrderIds) {
    const order = state.orders.get(id);
    if (order === undefined) continue;
    inSettlement.push({
      id: order.id,
      side: order.side,
      sellAmount: toBig(order.sellAmount),
      minBuyAmount: toBig(order.minBuyAmount),
    });
  }
  const stillOpen: BookOrder[] = readings.openOrders.map((order) => ({
    id: order.id,
    side: order.side === "SELL_B_FOR_A" ? "SELL_B_FOR_A" : "SELL_A_FOR_B",
    sellAmount: toBig(order.sellAmount),
    minBuyAmount: toBig(order.minBuyAmount),
  }));

  const omitted = omittedFillable(inSettlement, stillOpen, params, mirror, pool);
  checks.that(
    "EC-4",
    "selection_omitted_total is zero: no fillable order was left out",
    omitted.length === 0,
    `the settler could have filled ${omitted.join(", ")}`,
  );
}

/** FL-7: an evicted settlement never has an L1 receipt and never spent gas. */
export function checkFreeFailure(checks: Checks, state: RunState): void {
  for (const settlement of state.settlements.values()) {
    if (settlement.outcome !== "evicted") continue;
    checks.that(
      "FL-7",
      `window ${settlement.windowId}: poison eviction cost zero L1 gas`,
      settlement.l1Receipt === null && !settlement.l1GasSpent,
      `receipt ${JSON.stringify(settlement.l1Receipt)}, l1GasSpent ${settlement.l1GasSpent}`,
    );
  }
}

/** EC-5: the DEX takes one of the bundle's slots, and the cap held. */
export function checkBundle(checks: Checks, readings: Readings): void {
  const bundle = readings.bundle;
  if (bundle === undefined) return;
  checks.that(
    "EC-5",
    `the DEX rode the bundle in one cross-layer transaction (slot ${bundle.l1Block})`,
    bundle.dexTxs === 1,
    `the DEX had ${bundle.dexTxs} transactions in the bundle`,
  );
  checks.that(
    "EC-5",
    `the bundle held ${bundle.crossLayerTxs} cross-layer transactions within a cap of ${bundle.cap}`,
    bundle.crossLayerTxs <= bundle.cap,
    `${bundle.crossLayerTxs} > ${bundle.cap}`,
  );
}

/** A.6's happy path, over and above the checks every run gets. */
export function checkHappyPath(checks: Checks, state: RunState, readings: Readings): void {
  const settled = [...state.settlements.values()].filter((settlement) => settlement.outcome === "settled");
  const expected = readings.expect.settlements ?? 1;
  checks.equal("HX-2", `exactly ${expected} cross-layer transaction settled the window`, settled.length, expected);

  const fills = readings.expect.fillsPerSettlement;
  if (fills !== undefined) {
    checks.equal(
      "HX-2",
      `fills_per_settlement == ${fills}`,
      state.metrics["fills_per_settlement"] ?? 0,
      fills,
    );
  }

  // A.6: recipients hold outputs — L2 balances [full], L1 balances [genesis].
  const credited = readings.balances.filter((balance) => toBig(balance.amount) > 0n);
  checks.that(
    "CT-11",
    `every recipient holds its output (${credited.length} of ${readings.balances.length} balances non-zero)`,
    readings.balances.length > 0 && credited.length === readings.balances.length,
    readings.balances
      .filter((balance) => toBig(balance.amount) === 0n)
      .map((balance) => `${balance.owner} holds none of ${balance.asset}`)
      .join("; "),
  );
}

/** HX-4: every order in the soak reached a terminal state. */
export function checkAllOrdersTerminal(checks: Checks, state: RunState): void {
  const stranded = [...state.orders.values()].filter(
    (order) => order.state !== "filled" && order.state !== "cancelled" && order.state !== "expired",
  );
  checks.that(
    "HX-4",
    `every one of ${state.orders.size} orders reached a terminal state`,
    stranded.length === 0,
    `${stranded.length} orders are still ${[...new Set(stranded.map((order) => order.state))].join("/")}`,
  );
}

/**
 * HX-4's third pass condition: "amortisation metrics and `roll_rate`
 * reported". A soak that drifted no escrow and stranded no order has proved
 * the mechanism is safe; these are the numbers that say whether it is worth
 * running, and A.6 asks for them in the same breath.
 *
 * Every name is A.5's, taken from the frozen list — the registry publishes
 * them at zero from the first tick, so a quiet run reports `0` rather than
 * omitting the line, and a reader can tell the two apart.
 */
export function reportMetrics(checks: Checks, state: RunState): void {
  const metrics = state.metrics;
  const at = (name: string): number => metrics[name] ?? 0;
  const fills = at("fills_per_settlement");
  const perFill = at("gas_per_fill_wei");
  const counterfactual = at("counterfactual_l1_gas_wei");

  checks.note("A.5", `fills_per_settlement ${fills}`);
  checks.note("A.5", `netting_ratio ${at("netting_ratio")}`);
  checks.note("A.5", `roll_rate ${at("roll_rate")}`);
  checks.note("IX-3", `gas_per_fill_wei ${perFill} against counterfactual_l1_gas_wei ${counterfactual}`);
  // The amortisation claim in one number, and honest when there is nothing to
  // divide: a missing denominator is reported, never invented (IX-3).
  checks.note(
    "EC-5",
    perFill === 0 || counterfactual === 0
      ? "amortisation: not measurable — no settlement carried both a receipt and a counterfactual"
      : `amortisation: ${(counterfactual / perFill).toFixed(2)}x the direct-L1 cost per fill`,
  );
}

/** The whole assertion set for a run, chosen by what the harness expects. */
export function assertRun(events: readonly SlotEvent[], readings: Readings): { lines: string[]; failures: number } {
  const checks = new Checks();
  const state = stateOf(events);

  checkEscrowInvariant(checks, readings);
  checkNoFillBelowLimit(checks, state);
  checkClearingPrices(checks, state);
  checkResidualMatchesLeg(checks, state);
  checkAgainstOracle(checks, state, readings);
  checkFreeFailure(checks, state);
  checkBundle(checks, readings);

  if (readings.expect.mode === "happy") {
    checkMirrorEqualsPool(checks, readings);
    checkSelectionAudit(checks, state, readings);
    checkHappyPath(checks, state, readings);
  }
  if (readings.expect.allOrdersTerminal === true) checkAllOrdersTerminal(checks, state);

  reportMetrics(checks, state);

  const drift = state.metrics["escrow_invariant_drift_wei"] ?? 0;
  checks.equal("A.5", "escrow_invariant_drift_wei is zero across the run", drift, 0);

  return checks.summary(`A.6 ${readings.expect.mode}`);
}

/** How far two prices are apart, for a report line. */
export function priceGap(a: string, b: string): string {
  return fromBig(absDiff(toBig(a), toBig(b)));
}
