/**
 * The recorded run, validated against the frozen schema — RD-2 HX-5, IX-2.
 *
 * `indexer/schema/` is frozen and is the arbiter: if a fixture and the schema
 * disagree, the fixture is wrong. TypeScript checks the shape of everything
 * this repository *writes*, but a fixture on disk is data, so it is checked at
 * run time too — against the schema's own exported constants (`SLOT_EVENT_KINDS`,
 * `WINDOW_STATES`, `ORDER_STATES`, `SIDES`, `METRIC_NAMES`, `SCHEMA_VERSION`),
 * never against a list transcribed here.
 *
 * It also enforces what the schema can only document: the sequence is
 * monotonic, every wide number is a decimal string, and every state change a
 * window or an order makes is one A.4 allows. A fixture that replays into an
 * illegal transition would make "replay equals live" (TS-5) false.
 */

import {
  COUNTERFACTUAL_SOURCES,
  METRIC_NAMES,
  MIRROR_SOURCES,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  ROLLBACK_CAUSES,
  SCHEMA_VERSION,
  SETTLEMENT_OUTCOMES,
  SIDES,
  SLOT_EVENT_KINDS,
  WINDOW_OUTCOMES,
  WINDOW_STATES,
  WINDOW_TRANSITIONS,
  canTransition,
} from "../../indexer/schema/index.ts";
import type { OrderState, SlotEvent, WindowState } from "../../indexer/schema/index.ts";

/** Everything wrong with a fixture, rather than the first thing. */
export class ValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the recorded run does not conform to the IX-2 schema:\n  - ${problems.join("\n  - ")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}

const DECIMAL = /^-?\d+$/;
const HASH32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

class Checker {
  readonly problems: string[] = [];

  fail(where: string, what: string): void {
    this.problems.push(`${where}: ${what}`);
  }

  decimal(where: string, value: unknown): void {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
      this.fail(where, `expected a decimal string, got ${JSON.stringify(value)}`);
    }
  }

  hash(where: string, value: unknown): void {
    if (typeof value !== "string" || !HASH32.test(value)) {
      this.fail(where, `expected a lower-case 32-byte hash, got ${JSON.stringify(value)}`);
    }
  }

  address(where: string, value: unknown): void {
    if (typeof value !== "string" || !ADDRESS.test(value)) {
      this.fail(where, `expected a lower-case address, got ${JSON.stringify(value)}`);
    }
  }

  integer(where: string, value: unknown): void {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.fail(where, `expected an integer, got ${JSON.stringify(value)}`);
    }
  }

  oneOf(where: string, value: unknown, allowed: readonly string[]): void {
    if (typeof value !== "string" || !allowed.includes(value)) {
      this.fail(where, `expected one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}`);
    }
  }

  version(where: string, value: unknown): void {
    if (value !== SCHEMA_VERSION) {
      this.fail(where, `schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(value)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPoolState(check: Checker, where: string, value: unknown): void {
  if (!isRecord(value)) return check.fail(where, "expected a PoolState object");
  check.decimal(`${where}.sqrtPriceX96`, value["sqrtPriceX96"]);
  check.decimal(`${where}.liquidity`, value["liquidity"]);
  check.integer(`${where}.tick`, value["tick"]);
}

function checkWindow(check: Checker, where: string, value: unknown, states: Map<string, WindowState>): void {
  if (!isRecord(value)) return check.fail(where, "expected a Window object");
  check.version(`${where}.schemaVersion`, value["schemaVersion"]);
  check.decimal(`${where}.windowId`, value["windowId"]);
  check.oneOf(`${where}.state`, value["state"], WINDOW_STATES);
  if (value["slots"] !== 1 && value["slots"] !== 2) check.fail(`${where}.slots`, "EC-6 allows 1 or 2");
  check.integer(`${where}.openedAtL2Block`, value["openedAtL2Block"]);
  check.integer(`${where}.openedAtUnix`, value["openedAtUnix"]);
  if (value["syncL2Block"] !== null) check.integer(`${where}.syncL2Block`, value["syncL2Block"]);
  if (value["settlementId"] !== null) check.hash(`${where}.settlementId`, value["settlementId"]);
  check.decimal(`${where}.grossIn`, value["grossIn"]);
  check.decimal(`${where}.residualIn`, value["residualIn"]);
  if (value["residualSide"] !== null) check.oneOf(`${where}.residualSide`, value["residualSide"], SIDES);
  if (value["nettingRatio"] !== null && typeof value["nettingRatio"] !== "number") {
    check.fail(`${where}.nettingRatio`, "expected a number or null");
  }
  for (const key of ["orderIds", "selectedOrderIds"] as const) {
    const ids = value[key];
    if (!Array.isArray(ids)) {
      check.fail(`${where}.${key}`, "expected an array of ids");
      continue;
    }
    ids.forEach((id, index) => check.hash(`${where}.${key}[${index}]`, id));
  }

  const id = String(value["windowId"]);
  const to = value["state"];
  if (typeof to !== "string" || !WINDOW_STATES.includes(to as WindowState)) return;
  const from = states.get(id);
  if (from !== undefined && from !== to && !canTransition(WINDOW_TRANSITIONS, from, to as WindowState)) {
    check.fail(where, `A.4 forbids the window transition ${from} -> ${to}`);
  }
  states.set(id, to as WindowState);
}

function checkOrder(check: Checker, where: string, value: unknown, states: Map<string, OrderState>): void {
  if (!isRecord(value)) return check.fail(where, "expected an Order object");
  check.version(`${where}.schemaVersion`, value["schemaVersion"]);
  check.hash(`${where}.id`, value["id"]);
  check.address(`${where}.owner`, value["owner"]);
  check.oneOf(`${where}.side`, value["side"], SIDES);
  check.decimal(`${where}.sellAmount`, value["sellAmount"]);
  check.decimal(`${where}.minBuyAmount`, value["minBuyAmount"]);
  check.address(`${where}.recipient`, value["recipient"]);
  check.integer(`${where}.expiresAfter`, value["expiresAfter"]);
  check.oneOf(`${where}.state`, value["state"], ORDER_STATES);
  check.integer(`${where}.placedAtL2Block`, value["placedAtL2Block"]);
  check.integer(`${where}.placedAtUnix`, value["placedAtUnix"]);
  check.decimal(`${where}.windowId`, value["windowId"]);
  check.integer(`${where}.rolledCount`, value["rolledCount"]);

  const fill = value["fill"];
  if (fill !== null) {
    if (!isRecord(fill)) check.fail(`${where}.fill`, "expected an OrderFill object or null");
    else {
      check.decimal(`${where}.fill.windowId`, fill["windowId"]);
      for (const key of ["amountOut", "feeAmount", "routeFeeAmount", "impactAmount", "priceX96"] as const) {
        check.decimal(`${where}.fill.${key}`, fill[key]);
      }
      if (typeof fill["crossed"] !== "boolean") check.fail(`${where}.fill.crossed`, "expected a boolean");
      check.hash(`${where}.fill.settlementId`, fill["settlementId"]);
    }
  }

  const id = String(value["id"]);
  const to = value["state"];
  if (typeof to !== "string" || !ORDER_STATES.includes(to as OrderState)) return;
  const from = states.get(id);
  if (from !== undefined && from !== to && !canTransition(ORDER_TRANSITIONS, from, to as OrderState)) {
    check.fail(where, `A.4 forbids the order transition ${from} -> ${to}`);
  }
  states.set(id, to as OrderState);
}

function checkSettlement(check: Checker, where: string, value: unknown): void {
  if (!isRecord(value)) return check.fail(where, "expected a Settlement object");
  check.version(`${where}.schemaVersion`, value["schemaVersion"]);
  check.hash(`${where}.id`, value["id"]);
  check.decimal(`${where}.windowId`, value["windowId"]);
  check.oneOf(`${where}.outcome`, value["outcome"], SETTLEMENT_OUTCOMES);
  if (typeof value["l1GasSpent"] !== "boolean") check.fail(`${where}.l1GasSpent`, "expected a boolean");
  if (value["rollbackCause"] !== null) {
    check.oneOf(`${where}.rollbackCause`, value["rollbackCause"], ROLLBACK_CAUSES);
  }

  const leg = value["leg"];
  if (!isRecord(leg)) check.fail(`${where}.leg`, "expected a WindowLeg object");
  else {
    check.decimal(`${where}.leg.windowId`, leg["windowId"]);
    check.oneOf(`${where}.leg.residualSide`, leg["residualSide"], SIDES);
    for (const key of ["residualIn", "minPriceX96", "maxPriceX96"] as const) {
      check.decimal(`${where}.leg.${key}`, leg[key]);
    }
    check.integer(`${where}.leg.deadline`, leg["deadline"]);
  }

  const result = value["result"];
  if (result !== null) {
    if (!isRecord(result)) check.fail(`${where}.result`, "expected a WindowResult object or null");
    else {
      for (const key of ["amountIn", "amountOut", "referencePriceX96", "executionPriceX96"] as const) {
        check.decimal(`${where}.result.${key}`, result[key]);
      }
      checkPoolState(check, `${where}.result.post`, result["post"]);
      check.integer(`${where}.result.l1Block`, result["l1Block"]);
    }
  }

  const receipt = value["l1Receipt"];
  if (receipt !== null) {
    if (!isRecord(receipt)) check.fail(`${where}.l1Receipt`, "expected an L1Receipt object or null");
    else {
      check.hash(`${where}.l1Receipt.txHash`, receipt["txHash"]);
      check.integer(`${where}.l1Receipt.blockNumber`, receipt["blockNumber"]);
      for (const key of ["gasUsed", "effectiveGasPriceWei", "gasCostWei"] as const) {
        check.decimal(`${where}.l1Receipt.${key}`, receipt[key]);
      }
      check.oneOf(`${where}.l1Receipt.status`, receipt["status"], ["success", "reverted"]);
    }
  }

  // FL-7's free failure, in the data: an evicted settlement never has a
  // receipt, because there was no L1 transaction to have one.
  if (value["outcome"] === "evicted" && receipt !== null) {
    check.fail(where, "an evicted settlement cannot carry an L1 receipt (FL-7)");
  }
  if (value["outcome"] === "evicted" && value["l1GasSpent"] === true) {
    check.fail(where, "poison eviction costs zero L1 gas (FL-7)");
  }

  for (const key of ["filledOrderIds", "droppedOrderIds"] as const) {
    const ids = value[key];
    if (!Array.isArray(ids)) {
      check.fail(`${where}.${key}`, "expected an array of ids");
      continue;
    }
    ids.forEach((id, index) => check.hash(`${where}.${key}[${index}]`, id));
  }

  const amortisation = value["amortisation"];
  if (amortisation !== null) {
    if (!isRecord(amortisation)) check.fail(`${where}.amortisation`, "expected an Amortisation object or null");
    else {
      check.version(`${where}.amortisation.schemaVersion`, amortisation["schemaVersion"]);
      check.hash(`${where}.amortisation.settlementId`, amortisation["settlementId"]);
      check.decimal(`${where}.amortisation.windowId`, amortisation["windowId"]);
      check.integer(`${where}.amortisation.fills`, amortisation["fills"]);
      for (const key of ["l1GasUsed", "l1GasCostWei", "counterfactualGasCostWei", "savingsWei"] as const) {
        check.decimal(`${where}.amortisation.${key}`, amortisation[key]);
      }
      if (amortisation["gasPerFillWei"] !== null) {
        check.decimal(`${where}.amortisation.gasPerFillWei`, amortisation["gasPerFillWei"]);
      }
      const perOrder = amortisation["perOrder"];
      if (!Array.isArray(perOrder)) check.fail(`${where}.amortisation.perOrder`, "expected an array");
      else {
        perOrder.forEach((entry, index) => {
          const at = `${where}.amortisation.perOrder[${index}]`;
          if (!isRecord(entry)) return check.fail(at, "expected an OrderCounterfactual object");
          check.hash(`${at}.orderId`, entry["orderId"]);
          check.decimal(`${at}.gasUsed`, entry["gasUsed"]);
          check.decimal(`${at}.gasCostWei`, entry["gasCostWei"]);
          check.oneOf(`${at}.source`, entry["source"], COUNTERFACTUAL_SOURCES);
        });
      }
    }
  }
}

function checkMirror(check: Checker, where: string, value: unknown): void {
  if (!isRecord(value)) return check.fail(where, "expected a MirrorSnapshot object");
  check.version(`${where}.schemaVersion`, value["schemaVersion"]);
  check.decimal(`${where}.windowId`, value["windowId"]);
  checkPoolState(check, `${where}.state`, value["state"]);
  check.decimal(`${where}.referencePriceX96`, value["referencePriceX96"]);
  check.integer(`${where}.l1Block`, value["l1Block"]);
  check.integer(`${where}.mirrorTimestamp`, value["mirrorTimestamp"]);
  check.integer(`${where}.ageSlots`, value["ageSlots"]);
  check.oneOf(`${where}.source`, value["source"], MIRROR_SOURCES);
  check.integer(`${where}.observedAtUnix`, value["observedAtUnix"]);
}

function checkMetrics(check: Checker, where: string, value: unknown): void {
  if (!isRecord(value)) return check.fail(where, "expected a metrics object");
  for (const [key, metric] of Object.entries(value)) {
    // `windows_total` is the one labelled metric (A.5).
    const name = key.startsWith("windows_total{") ? "windows_total" : key;
    if (!METRIC_NAMES.includes(name as (typeof METRIC_NAMES)[number])) {
      check.fail(`${where}.${key}`, "is not one of A.5's frozen metric names");
    }
    if (key.startsWith("windows_total{")) {
      const outcome = key.slice('windows_total{outcome="'.length, -2);
      if (!WINDOW_OUTCOMES.includes(outcome as (typeof WINDOW_OUTCOMES)[number])) {
        check.fail(`${where}.${key}`, `'${outcome}' is not one of A.5's window outcomes`);
      }
    }
    if (typeof metric !== "number" || !Number.isFinite(metric)) {
      check.fail(`${where}.${key}`, "expected a finite number");
    }
  }
}

/**
 * Validates a parsed recorded run. Returns it typed on success and throws a
 * {@link ValidationError} listing every problem on failure.
 */
export function validate(run: unknown): SlotEvent[] {
  const check = new Checker();
  if (!Array.isArray(run)) {
    throw new ValidationError(["the recorded run must be an array of SlotEvent"]);
  }

  const windowStates = new Map<string, WindowState>();
  const orderStates = new Map<string, OrderState>();
  let previousSeq = 0;

  run.forEach((event, index) => {
    const where = `events[${index}]`;
    if (!isRecord(event)) return check.fail(where, "expected an object");
    check.version(`${where}.schemaVersion`, event["schemaVersion"]);
    check.oneOf(`${where}.kind`, event["kind"], SLOT_EVENT_KINDS);
    check.integer(`${where}.atUnix`, event["atUnix"]);

    const seq = event["seq"];
    if (typeof seq !== "number" || !Number.isInteger(seq)) check.fail(`${where}.seq`, "expected an integer");
    else if (seq <= previousSeq) check.fail(`${where}.seq`, `must be monotonic; ${seq} follows ${previousSeq}`);
    else previousSeq = seq;

    switch (event["kind"]) {
      case "slot":
        check.integer(`${where}.l1Block`, event["l1Block"]);
        check.decimal(`${where}.windowId`, event["windowId"]);
        break;
      case "l2_block":
        check.integer(`${where}.l2Block`, event["l2Block"]);
        check.decimal(`${where}.windowId`, event["windowId"]);
        check.integer(`${where}.blocksRemaining`, event["blocksRemaining"]);
        break;
      case "window":
        checkWindow(check, `${where}.window`, event["window"], windowStates);
        break;
      case "order":
        checkOrder(check, `${where}.order`, event["order"], orderStates);
        break;
      case "settlement":
        checkSettlement(check, `${where}.settlement`, event["settlement"]);
        break;
      case "mirror":
        checkMirror(check, `${where}.mirror`, event["mirror"]);
        break;
      case "metrics":
        checkMetrics(check, `${where}.metrics`, event["metrics"]);
        break;
      default:
        break;
    }
  });

  if (check.problems.length > 0) throw new ValidationError(check.problems);
  return run as SlotEvent[];
}

/** Validates a fixture file and reports what it covers. */
export function describeRun(events: readonly SlotEvent[]): {
  readonly windowOutcomes: Record<string, number>;
  readonly orders: number;
  readonly settlements: number;
} {
  const outcomes: Record<string, number> = {};
  const seen = new Set<string>();
  const orders = new Set<string>();
  const settlements = new Set<string>();

  for (const event of events) {
    if (event.kind === "order") orders.add(event.order.id);
    if (event.kind === "settlement") settlements.add(event.settlement.id);
    if (event.kind !== "window") continue;
    const key = `${event.window.windowId}:${event.window.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes[event.window.state] = (outcomes[event.window.state] ?? 0) + 1;
  }

  return { windowOutcomes: outcomes, orders: orders.size, settlements: settlements.size };
}
