/**
 * The frozen schema, enforced at the boundary — RD-2 IX-2, TS-5.
 *
 * Everything that enters this gateway from outside it — a recorded run (HX-5),
 * the settler's projection — is checked here against `schema/`, and everything
 * that leaves it can be checked with the same functions. That is what makes
 * "the schema is the arbiter" (WP-4/WP-5 soft contract) something the code can
 * be held to rather than a sentence in a prompt.
 *
 * A version this build does not know is **refused, not guessed at**: a fixture
 * may be months older than the reader, and silently mis-reading it is how
 * replay stops equalling live (`schema/version.ts`).
 *
 * Fail loudly at the boundary, trust internally (`CLAUDE.md`): nothing past
 * these functions re-validates.
 */

import {
  MIRROR_SOURCES,
  ORDER_STATES,
  ROLLBACK_CAUSES,
  SCHEMA_VERSION,
  SETTLEMENT_OUTCOMES,
  SIDES,
  SLOT_EVENT_KINDS,
  WINDOW_STATES,
  COUNTERFACTUAL_SOURCES,
} from "../schema/index.ts";
import type {
  Amortisation,
  MirrorSnapshot,
  Order,
  OrderFill,
  PoolState,
  Settlement,
  SlotEvent,
  Window,
  WindowLeg,
  WindowResult,
} from "../schema/index.ts";

/** A value did not conform to the frozen schema, and this is where. */
export class SchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(path, `expected an object, got ${describe(value)}`);
  }
  return value as Json;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function str(source: Json, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new SchemaError(`${path}.${key}`, `expected a string, got ${describe(value)}`);
  return value;
}

/** A quantity too wide for a double, and therefore a decimal string (A.1). */
function dec(source: Json, key: string, path: string): string {
  const value = str(source, key, path);
  if (!/^-?\d+$/.test(value)) throw new SchemaError(`${path}.${key}`, `expected a decimal string, got ${value}`);
  return value;
}

function num(source: Json, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaError(`${path}.${key}`, `expected a number, got ${describe(value)}`);
  }
  return value;
}

function bool(source: Json, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new SchemaError(`${path}.${key}`, `expected a boolean, got ${describe(value)}`);
  return value;
}

function enumeration<T extends string>(source: Json, key: string, allowed: readonly T[], path: string): T {
  const value = str(source, key, path);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SchemaError(`${path}.${key}`, `expected one of ${allowed.join(" | ")}, got ${value}`);
  }
  return value as T;
}

function nullable<T>(source: Json, key: string, read: () => T): T | null {
  const value = source[key];
  return value === null || value === undefined ? null : read();
}

function array(source: Json, key: string, path: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new SchemaError(`${path}.${key}`, `expected an array, got ${describe(value)}`);
  return value;
}

function strings(source: Json, key: string, path: string): readonly string[] {
  return array(source, key, path).map((entry, index) => {
    if (typeof entry !== "string") throw new SchemaError(`${path}.${key}[${index}]`, "expected a string");
    return entry;
  });
}

/** Refuses a version this build would mis-read (`schema/version.ts`). */
function version(source: Json, path: string): typeof SCHEMA_VERSION {
  const value = num(source, "schemaVersion", path);
  if (value !== SCHEMA_VERSION) {
    throw new SchemaError(
      `${path}.schemaVersion`,
      `this build speaks schema version ${SCHEMA_VERSION}, the stream says ${value}; refusing rather than guessing`,
    );
  }
  return SCHEMA_VERSION;
}

function poolState(value: unknown, path: string): PoolState {
  const source = object(value, path);
  return {
    sqrtPriceX96: dec(source, "sqrtPriceX96", path),
    liquidity: dec(source, "liquidity", path),
    tick: num(source, "tick", path),
  };
}

/** IX-2's `Window`. */
export function parseWindow(value: unknown, path = "window"): Window {
  const source = object(value, path);
  const slots = num(source, "slots", path);
  if (slots !== 1 && slots !== 2) throw new SchemaError(`${path}.slots`, `EC-6 allows 1 or 2, got ${slots}`);

  return {
    schemaVersion: version(source, path),
    windowId: dec(source, "windowId", path),
    state: enumeration(source, "state", WINDOW_STATES, path),
    slots,
    openedAtL2Block: num(source, "openedAtL2Block", path),
    openedAtUnix: num(source, "openedAtUnix", path),
    syncL2Block: nullable(source, "syncL2Block", () => num(source, "syncL2Block", path)),
    orderIds: strings(source, "orderIds", path),
    selectedOrderIds: strings(source, "selectedOrderIds", path),
    settlementId: nullable(source, "settlementId", () => str(source, "settlementId", path)),
    grossIn: dec(source, "grossIn", path),
    residualIn: dec(source, "residualIn", path),
    residualSide: nullable(source, "residualSide", () => enumeration(source, "residualSide", SIDES, path)),
    nettingRatio: nullable(source, "nettingRatio", () => num(source, "nettingRatio", path)),
  };
}

function orderFill(value: unknown, path: string): OrderFill {
  const source = object(value, path);
  return {
    windowId: dec(source, "windowId", path),
    amountOut: dec(source, "amountOut", path),
    feeAmount: dec(source, "feeAmount", path),
    routeFeeAmount: dec(source, "routeFeeAmount", path),
    impactAmount: dec(source, "impactAmount", path),
    priceX96: dec(source, "priceX96", path),
    crossed: bool(source, "crossed", path),
    settlementId: str(source, "settlementId", path),
  };
}

/** IX-2's `Order`. */
export function parseOrder(value: unknown, path = "order"): Order {
  const source = object(value, path);
  return {
    schemaVersion: version(source, path),
    id: str(source, "id", path),
    owner: str(source, "owner", path),
    side: enumeration(source, "side", SIDES, path),
    sellAmount: dec(source, "sellAmount", path),
    minBuyAmount: dec(source, "minBuyAmount", path),
    recipient: str(source, "recipient", path),
    expiresAfter: num(source, "expiresAfter", path),
    state: enumeration(source, "state", ORDER_STATES, path),
    placedAtL2Block: num(source, "placedAtL2Block", path),
    placedAtUnix: num(source, "placedAtUnix", path),
    windowId: dec(source, "windowId", path),
    rolledCount: num(source, "rolledCount", path),
    fill: nullable(source, "fill", () => orderFill(source["fill"], `${path}.fill`)),
  };
}

function windowLeg(value: unknown, path: string): WindowLeg {
  const source = object(value, path);
  return {
    windowId: dec(source, "windowId", path),
    residualSide: enumeration(source, "residualSide", SIDES, path),
    residualIn: dec(source, "residualIn", path),
    minPriceX96: dec(source, "minPriceX96", path),
    maxPriceX96: dec(source, "maxPriceX96", path),
    deadline: num(source, "deadline", path),
  };
}

function windowResult(value: unknown, path: string): WindowResult {
  const source = object(value, path);
  return {
    amountIn: dec(source, "amountIn", path),
    amountOut: dec(source, "amountOut", path),
    referencePriceX96: dec(source, "referencePriceX96", path),
    executionPriceX96: dec(source, "executionPriceX96", path),
    post: poolState(source["post"], `${path}.post`),
    l1Block: num(source, "l1Block", path),
  };
}

function amortisation(value: unknown, path: string): Amortisation {
  const source = object(value, path);
  return {
    schemaVersion: version(source, path),
    settlementId: str(source, "settlementId", path),
    windowId: dec(source, "windowId", path),
    fills: num(source, "fills", path),
    l1GasUsed: dec(source, "l1GasUsed", path),
    l1GasCostWei: dec(source, "l1GasCostWei", path),
    gasPerFillWei: nullable(source, "gasPerFillWei", () => dec(source, "gasPerFillWei", path)),
    counterfactualGasCostWei: dec(source, "counterfactualGasCostWei", path),
    savingsWei: dec(source, "savingsWei", path),
    perOrder: array(source, "perOrder", path).map((entry, index) => {
      const order = object(entry, `${path}.perOrder[${index}]`);
      const at = `${path}.perOrder[${index}]`;
      return {
        orderId: str(order, "orderId", at),
        gasUsed: dec(order, "gasUsed", at),
        gasCostWei: dec(order, "gasCostWei", at),
        source: enumeration(order, "source", COUNTERFACTUAL_SOURCES, at),
      };
    }),
  };
}

/** IX-2's `Settlement`. */
export function parseSettlement(value: unknown, path = "settlement"): Settlement {
  const source = object(value, path);
  return {
    schemaVersion: version(source, path),
    id: str(source, "id", path),
    windowId: dec(source, "windowId", path),
    outcome: enumeration(source, "outcome", SETTLEMENT_OUTCOMES, path),
    leg: windowLeg(source["leg"], `${path}.leg`),
    result: nullable(source, "result", () => windowResult(source["result"], `${path}.result`)),
    l1Receipt: nullable(source, "l1Receipt", () => {
      const receipt = object(source["l1Receipt"], `${path}.l1Receipt`);
      const at = `${path}.l1Receipt`;
      return {
        txHash: str(receipt, "txHash", at),
        blockNumber: num(receipt, "blockNumber", at),
        gasUsed: dec(receipt, "gasUsed", at),
        effectiveGasPriceWei: dec(receipt, "effectiveGasPriceWei", at),
        gasCostWei: dec(receipt, "gasCostWei", at),
        status: enumeration(receipt, "status", ["success", "reverted"] as const, at),
      };
    }),
    rollbackCause: nullable(source, "rollbackCause", () =>
      enumeration(source, "rollbackCause", ROLLBACK_CAUSES, path),
    ),
    l1GasSpent: bool(source, "l1GasSpent", path),
    filledOrderIds: strings(source, "filledOrderIds", path),
    droppedOrderIds: strings(source, "droppedOrderIds", path),
    submittedAtUnix: num(source, "submittedAtUnix", path),
    settledAtUnix: nullable(source, "settledAtUnix", () => num(source, "settledAtUnix", path)),
    amortisation: nullable(source, "amortisation", () => amortisation(source["amortisation"], `${path}.amortisation`)),
  };
}

/** IX-2's `MirrorSnapshot`. */
export function parseMirrorSnapshot(value: unknown, path = "mirror"): MirrorSnapshot {
  const source = object(value, path);
  return {
    schemaVersion: version(source, path),
    windowId: dec(source, "windowId", path),
    state: poolState(source["state"], `${path}.state`),
    referencePriceX96: dec(source, "referencePriceX96", path),
    l1Block: num(source, "l1Block", path),
    mirrorTimestamp: num(source, "mirrorTimestamp", path),
    ageSlots: num(source, "ageSlots", path),
    source: enumeration(source, "source", MIRROR_SOURCES, path),
    observedAtUnix: num(source, "observedAtUnix", path),
  };
}

/** IX-2's `SlotEvent` — the envelope everything on the stream travels in. */
export function parseSlotEvent(value: unknown, path = "event"): SlotEvent {
  const source = object(value, path);
  const schemaVersion = version(source, path);
  const kind = enumeration(source, "kind", SLOT_EVENT_KINDS, path);
  const seq = num(source, "seq", path);
  const atUnix = num(source, "atUnix", path);
  const base = { schemaVersion, seq, atUnix } as const;

  switch (kind) {
    case "slot":
      return { ...base, kind, l1Block: num(source, "l1Block", path), windowId: dec(source, "windowId", path) };
    case "l2_block":
      return {
        ...base,
        kind,
        l2Block: num(source, "l2Block", path),
        windowId: dec(source, "windowId", path),
        blocksRemaining: num(source, "blocksRemaining", path),
      };
    case "window":
      return { ...base, kind, window: parseWindow(source["window"], `${path}.window`) };
    case "order":
      return { ...base, kind, order: parseOrder(source["order"], `${path}.order`) };
    case "settlement":
      return { ...base, kind, settlement: parseSettlement(source["settlement"], `${path}.settlement`) };
    case "mirror":
      return { ...base, kind, mirror: parseMirrorSnapshot(source["mirror"], `${path}.mirror`) };
    case "metrics": {
      const metrics = object(source["metrics"], `${path}.metrics`);
      const values: Record<string, number> = {};
      for (const [name, metric] of Object.entries(metrics)) {
        if (typeof metric !== "number") throw new SchemaError(`${path}.metrics.${name}`, "expected a number");
        values[name] = metric;
      }
      return { ...base, kind, metrics: values };
    }
  }
}

/** Whether a value is a conforming event, for callers that want a boolean. */
export function isSlotEvent(value: unknown): value is SlotEvent {
  try {
    parseSlotEvent(value);
    return true;
  } catch (error) {
    if (error instanceof SchemaError) return false;
    throw error;
  }
}

/**
 * Every schema violation in a snapshot body, or an empty array.
 *
 * This is what `curl /snapshot | validate` is for: the gateway's own output,
 * held to the same contract as its input.
 */
export function validateSnapshot(value: unknown): readonly string[] {
  const issues: string[] = [];
  const check = (read: () => unknown) => {
    try {
      read();
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      issues.push(error.message);
    }
  };

  check(() => {
    const source = object(value, "snapshot");
    version(source, "snapshot");
    for (const [index, window] of array(source, "windows", "snapshot").entries()) {
      check(() => parseWindow(window, `snapshot.windows[${index}]`));
    }
    for (const [index, order] of array(source, "orders", "snapshot").entries()) {
      check(() => parseOrder(order, `snapshot.orders[${index}]`));
    }
    for (const [index, settlement] of array(source, "settlements", "snapshot").entries()) {
      check(() => parseSettlement(settlement, `snapshot.settlements[${index}]`));
    }
    if (source["mirror"] !== null) check(() => parseMirrorSnapshot(source["mirror"], "snapshot.mirror"));
  });

  return issues;
}
