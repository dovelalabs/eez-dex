/**
 * The settler's view, as the gateway reads it — RD-2 IX-1, A.5, SV-4.
 *
 * `settler/src/stream.rs` projects the settler's state into **this** schema —
 * the frozen one — so the document below is that projection served over HTTP,
 * and this module is a boundary check rather than a translation.
 *
 * It is a distinct upstream because it is the only one that can answer three
 * questions the chain cannot. The price band and the residual side are built
 * inside `settleWindow` and never emitted (A.2). An eviction is the *absence*
 * of a transaction, so nothing is logged when a window is poison-evicted
 * (FL-7). A rollback un-happens the L2 blocks that carried the logs (SV-4).
 * Where this upstream is absent the stream says so and leaves those fields
 * null; it never fills them in with a guess.
 */

import type { MirrorSnapshot, Order, Settlement, Window } from "../schema/index.ts";
import { parseMirrorSnapshot, parseOrder, parseSettlement, parseWindow, SchemaError } from "./validate.ts";

/** One settlement as the settler classified it, plus its L1 transaction. */
export interface SettlerSettlement {
  readonly settlement: Settlement;
  /**
   * The L1 transaction the leg rode in, when the reconciler has matched one.
   * The gateway reads the receipt itself: IX-3 is computed here, once.
   */
  readonly l1TxHash: string | null;
}

/** Everything the settler's projection tells the gateway. */
export interface SettlerView {
  readonly window: Window | null;
  readonly orders: readonly Order[];
  readonly mirror: MirrorSnapshot | null;
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly settlements: readonly SettlerSettlement[];
}

/** An empty view: the settler is reachable but has nothing to say yet. */
export const EMPTY_SETTLER_VIEW: SettlerView = {
  window: null,
  orders: [],
  mirror: null,
  metrics: null,
  settlements: [],
};

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

/**
 * `metrics` is either the A.5 map or `stream.rs`'s `{schemaVersion, metrics}`
 * envelope; both carry the same frozen names (`schema/metrics.ts`).
 */
function readMetrics(value: unknown): Readonly<Record<string, number>> | null {
  if (value === null || value === undefined) return null;
  const source = asObject(value, "settler.metrics");
  const inner = source["metrics"] === undefined ? source : asObject(source["metrics"], "settler.metrics.metrics");
  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(inner)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

/**
 * Defaults for the parts of a settlement the settler may not project.
 *
 * The receipt and the amortisation are the gateway's own work (IX-3), so a
 * settler that omits them is not a settler that is wrong.
 */
function settlementDefaults(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    l1Receipt: null,
    rollbackCause: null,
    amortisation: null,
    l1GasSpent: false,
    filledOrderIds: [],
    droppedOrderIds: [],
    settledAtUnix: null,
    result: null,
    ...entry,
  };
}

/** Parses the settler's document, refusing anything the schema does not allow. */
export function parseSettlerView(value: unknown): SettlerView {
  const source = asObject(value, "settler");
  const settlements = Array.isArray(source["settlements"]) ? source["settlements"] : [];

  return {
    window: source["window"] === null || source["window"] === undefined ? null : parseWindow(source["window"], "settler.window"),
    orders: (Array.isArray(source["orders"]) ? source["orders"] : []).map((order, index) =>
      parseOrder(order, `settler.orders[${index}]`),
    ),
    mirror:
      source["mirror"] === null || source["mirror"] === undefined
        ? null
        : parseMirrorSnapshot(source["mirror"], "settler.mirror"),
    metrics: readMetrics(source["metrics"]),
    settlements: settlements.map((entry, index) => {
      const raw = asObject(entry, `settler.settlements[${index}]`);
      const l1TxHash = raw["l1TxHash"];
      return {
        settlement: parseSettlement(settlementDefaults(raw), `settler.settlements[${index}]`),
        l1TxHash: typeof l1TxHash === "string" ? l1TxHash.toLowerCase() : null,
      };
    }),
  };
}

/** Fetches and parses the settler's projection. */
export async function readSettlerView(url: string, fetchImpl: typeof fetch = fetch): Promise<SettlerView> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`settler ${url}: HTTP ${response.status}`);
  return parseSettlerView(await response.json());
}
