/**
 * The soak, without an enclave — RD-2 HX-4, §10.
 *
 * The 200-slot soak is an enclave row (RL-4 runs it nightly). Its *plan* is a
 * pure function of a seed, and the settlement oracle computes what
 * `WindowBook` and `SettlementRouter` would do with that plan — so the same
 * document drives both, and the same A.6 assertions read both.
 *
 * That is what this runs: the seeded plan against the oracle, folded by the
 * same recorder and asserted by the same checks. It proves the *mechanism* —
 * no fill below a limit, no escrow drift, no stranded order — and it reports
 * the A.5 numbers. It does **not** prove the chain: there is no composer here,
 * no bundle, no eviction that a real builder refused. Every report it writes
 * says `simulated` so a reader can never mistake one for the other, and
 * `scripts/verify.sh` prints the tier beside every row for the same reason.
 */

import { assertRun, stateOf } from "./assert.ts";
import type { Readings } from "./assert.ts";
import { FIXTURE_GAS, FIXTURE_PARAMS } from "./fixture.ts";
import { record } from "./record.ts";
import { readingsFrom } from "./simulate.ts";
import { DEFAULT_SOAK, runSoak, soakPlan } from "./soak.ts";
import { validate } from "./validate.ts";

/** How the soak was run, and what it produced. */
export interface SoakReport {
  /** Never `enclave`: this module cannot produce one. */
  readonly tier: "simulated";
  readonly seed: string;
  readonly slots: number;
  readonly orders: number;
  readonly settlements: number;
  /** Orders that never reached `filled`, `cancelled` or `expired`. */
  readonly stranded: number;
  /** Fills whose `amountOut` was below the order's own limit (CT-10). */
  readonly limitViolations: number;
  /** The A.5 metrics the run published, under their frozen names. */
  readonly metrics: Readonly<Record<string, number>>;
  /** A.6's assertion report, line by line. */
  readonly lines: readonly string[];
  readonly failures: number;
}

/** The pool the soak runs against: 2,000,000 B of liquidity at 0.05%. */
const SOAK_LIQUIDITY = 2_000_000n * 10n ** 18n;
const SOAK_POOL_FEE = 500n;
const SOAK_START_UNIX = 1_788_000_000;

/**
 * Runs HX-4's soak against the oracle and asserts A.6 over it.
 *
 * `allOrdersTerminal` is asked of the whole run only when it can be met: an
 * order placed in the last windows has not had time to expire, so the check
 * is applied to the orders old enough to have reached a terminal state and
 * the count of the rest is reported rather than asserted.
 */
export function runSimulatedSoak(seed = DEFAULT_SOAK.seed.toString(), slots = DEFAULT_SOAK.slots): SoakReport {
  const plan = soakPlan({ seed, slots });
  const simulation = runSoak(plan, {
    params: FIXTURE_PARAMS,
    gas: FIXTURE_GAS,
    liquidity: SOAK_LIQUIDITY,
    poolFee: SOAK_POOL_FEE,
    startUnix: SOAK_START_UNIX,
  });

  const events = validate(record(simulation.observations).events);
  const state = stateOf(events);
  const readings = readingsFrom(
    simulation,
    FIXTURE_PARAMS,
    { mode: "soak", allOrdersTerminal: false },
    simulation.legInputs,
  ) as unknown as Readings;
  const report = assertRun(events, readings);

  const lastWindow = Math.max(...[...state.windows.values()].map((window) => Number(window.windowId)));
  const stranded = [...state.orders.values()].filter(
    (order) =>
      order.state !== "filled" &&
      order.state !== "cancelled" &&
      order.state !== "expired" &&
      Number(order.windowId) < lastWindow - DEFAULT_SOAK.expiresAfter,
  );

  let limitViolations = 0;
  for (const order of state.orders.values()) {
    if (order.fill === null) continue;
    if (BigInt(order.fill.amountOut) < BigInt(order.minBuyAmount)) limitViolations += 1;
  }

  return {
    tier: "simulated",
    seed,
    slots,
    orders: state.orders.size,
    settlements: state.settlements.size,
    stranded: stranded.length,
    limitViolations,
    metrics: state.metrics,
    lines: report.lines,
    failures: report.failures,
  };
}
