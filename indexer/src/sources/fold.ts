/**
 * The live fold — RD-2 IX-1, IX-2, A.4.
 *
 * One pure function turns everything the gateway read in a tick into the
 * events that tick produced. Pure because the fold is what "replay equals
 * live" is asserted against (TS-5): given the same observations it produces
 * the same sequence, on any machine, in any order of arrival — the read side's
 * half of the determinism the settler owes on the write side (SV-2).
 *
 * Two rules run through it:
 *
 * * **Never invent a transition.** Every state change is walked through the
 *   A.4 tables in `machine.ts`, so a `WindowSettled` seen by a gateway that
 *   never saw the submission emits `settling` and then `settled` rather than a
 *   transition the frontend's reducer is entitled to reject.
 * * **Never invent a number.** CT-12 emits every deduction absolutely, so a
 *   fill's price is derived from the amounts the chain stated. What the chain
 *   does not state — the price band, an eviction, a rollback — comes from the
 *   settler's projection or stays null.
 */

import type {
  MirrorSnapshot,
  Order,
  OrderState,
  Settlement,
  SlotEvent,
  Window,
  WindowState,
} from "../../schema/index.ts";
import { SCHEMA_VERSION } from "../../schema/index.ts";
import { amortisationFor } from "../amortisation.ts";
import type { BookLog, BookOrder, BookView } from "../chain/book.ts";
import type { GasSample, Receipt } from "../chain/l1.ts";
import { EMPTY_GAS_SAMPLE } from "../chain/l1.ts";
import { orderPath, windowPath } from "../machine.ts";
import { fillPriceX96, notionalInA, nettingRatio, residualSideFromResult, spotPriceX96 } from "../price.ts";
import type { SettlerView } from "../settler.ts";

/** The L2 head, as the gateway read it. */
export interface L2Head {
  readonly head: number;
  /** The safe head — where the escrow invariant is checked (CT-13). */
  readonly safeHead: number;
  readonly timestamp: number;
}

/** Everything one tick observed. Any part may be null: an upstream may be down. */
export interface ChainSample {
  readonly atUnix: number;
  readonly l2: L2Head | null;
  readonly book: BookView | null;
  readonly logs: readonly BookLog[];
  /** Timestamps of the L2 blocks that carried logs, so nothing is estimated. */
  readonly blockTimes: ReadonlyMap<number, number>;
  /** Orders the gateway had to look up because it never saw them placed. */
  readonly resolved: ReadonlyMap<string, BookOrder>;
  readonly l1: { readonly head: number; readonly timestamp: number } | null;
  readonly settler: SettlerView | null;
  /** Receipts by L1 transaction hash, for settlements the settler matched. */
  readonly receipts: ReadonlyMap<string, Receipt>;
  readonly gasSample: GasSample;
}

/** What the fold remembers between ticks. */
export interface LiveModel {
  readonly windows: ReadonlyMap<string, Window>;
  readonly orders: ReadonlyMap<string, Order>;
  readonly settlements: ReadonlyMap<string, Settlement>;
  /** The L1 transaction each settlement rode in, as the settler matched it. */
  readonly l1TxHashes: ReadonlyMap<string, string>;
  readonly mirror: MirrorSnapshot | null;
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly l1Block: number;
  readonly l2Block: number;
  readonly openWindowId: string | null;
  /** Log positions already folded, so a re-read of a range emits nothing twice. */
  readonly seenLogs: ReadonlySet<string>;
  /** The mirror's spot price, for the notional maths the book does (CT-9). */
  readonly priceX96: bigint;
  readonly gasSample: GasSample;
}

/** A gateway that has observed nothing — the state before the first tick. */
export function initialModel(): LiveModel {
  return {
    windows: new Map(),
    orders: new Map(),
    settlements: new Map(),
    l1TxHashes: new Map(),
    mirror: null,
    metrics: null,
    l1Block: 0,
    l2Block: 0,
    openWindowId: null,
    seenLogs: new Set(),
    priceX96: 0n,
    gasSample: EMPTY_GAS_SAMPLE,
  };
}

/**
 * How far the fold will catch up with tick events before it simply jumps.
 *
 * A gateway that starts against a chain thousands of blocks along must not
 * open with thousands of clock ticks: the theater's clock is the recent past,
 * and the state it renders comes from the fold, not from the ticks.
 */
const MAX_CATCHUP_TICKS = 12;

interface Draft {
  windows: Map<string, Window>;
  orders: Map<string, Order>;
  settlements: Map<string, Settlement>;
  l1TxHashes: Map<string, string>;
  mirror: MirrorSnapshot | null;
  metrics: Readonly<Record<string, number>> | null;
  l1Block: number;
  l2Block: number;
  openWindowId: string | null;
  seenLogs: Set<string>;
  priceX96: bigint;
  gasSample: GasSample;
  readonly events: SlotEvent[];
  readonly atUnix: number;
}

function draftFrom(model: LiveModel, atUnix: number): Draft {
  return {
    windows: new Map(model.windows),
    orders: new Map(model.orders),
    settlements: new Map(model.settlements),
    l1TxHashes: new Map(model.l1TxHashes),
    mirror: model.mirror,
    metrics: model.metrics,
    l1Block: model.l1Block,
    l2Block: model.l2Block,
    openWindowId: model.openWindowId,
    seenLogs: new Set(model.seenLogs),
    priceX96: model.priceX96,
    gasSample: model.gasSample,
    events: [],
    atUnix,
  };
}

function sealed(draft: Draft): LiveModel {
  return {
    windows: draft.windows,
    orders: draft.orders,
    settlements: draft.settlements,
    l1TxHashes: draft.l1TxHashes,
    mirror: draft.mirror,
    metrics: draft.metrics,
    l1Block: draft.l1Block,
    l2Block: draft.l2Block,
    openWindowId: draft.openWindowId,
    seenLogs: draft.seenLogs,
    priceX96: draft.priceX96,
    gasSample: draft.gasSample,
  };
}

/** A {@link SlotEvent} without the three fields the fold does not own. */
type Draftable<T> = T extends SlotEvent ? Omit<T, "schemaVersion" | "seq" | "atUnix"> : never;

/** The hub owns `seq`; the fold stamps the rest. */
function event(draft: Draft, drafted: Draftable<SlotEvent>): void {
  draft.events.push({ ...drafted, schemaVersion: SCHEMA_VERSION, seq: 0, atUnix: draft.atUnix } as SlotEvent);
}

function putWindow(draft: Draft, window: Window): void {
  draft.windows.set(window.windowId, window);
  event(draft, { kind: "window", window });
}

function putOrder(draft: Draft, order: Order): void {
  draft.orders.set(order.id, order);
  event(draft, { kind: "order", order });
}

function putSettlement(draft: Draft, settlement: Settlement): void {
  draft.settlements.set(settlement.id, settlement);
  event(draft, { kind: "settlement", settlement });
}

/** Moves a window to `to` through every state A.4 makes it pass through. */
function moveWindow(draft: Draft, windowId: string, to: WindowState, fields: Partial<Window> = {}): void {
  const current = draft.windows.get(windowId);
  if (current === undefined) return;
  const steps = windowPath(current.state, to);
  if (steps.length === 0) {
    putWindow(draft, { ...current, ...fields });
    return;
  }
  let window = current;
  for (const [index, state] of steps.entries()) {
    window = { ...window, state, ...(index === steps.length - 1 ? fields : {}) };
    putWindow(draft, window);
  }
}

/** Moves an order to `to` through every state A.4 makes it pass through. */
function moveOrder(draft: Draft, id: string, to: OrderState, fields: Partial<Order> = {}): void {
  const current = draft.orders.get(id);
  if (current === undefined) return;
  const steps = orderPath(current.state, to);
  if (steps.length === 0) {
    putOrder(draft, { ...current, ...fields });
    return;
  }
  let order = current;
  for (const [index, state] of steps.entries()) {
    order = { ...order, state, ...(index === steps.length - 1 ? fields : {}) };
    putOrder(draft, order);
  }
}

/** Opens a window the gateway had not seen, with the orders that rolled into it. */
function openWindow(draft: Draft, view: BookView): void {
  if (draft.windows.has(view.windowId)) return;
  const rolled = [...draft.orders.values()].filter((order) => order.windowId === view.windowId);
  // An order that rolled is volume this window holds, so it is in its gross
  // from the moment the window opens — otherwise the first settlement's
  // netting ratio would be measured against a window that looked empty.
  const grossIn = rolled.reduce(
    (total, order) => total + notionalInA(BigInt(order.sellAmount), order.side, draft.priceX96),
    0n,
  );

  putWindow(draft, {
    schemaVersion: SCHEMA_VERSION,
    windowId: view.windowId,
    state: "open",
    slots: view.slots === 1 ? 1 : 2,
    openedAtL2Block: view.startBlock,
    openedAtUnix: draft.atUnix,
    syncL2Block: null,
    orderIds: rolled.map((order) => order.id),
    selectedOrderIds: [],
    settlementId: null,
    grossIn: grossIn.toString(),
    residualIn: "0",
    residualSide: null,
    nettingRatio: null,
  });
}

function applyOrderPlaced(draft: Draft, log: Extract<BookLog, { kind: "order_placed" }>, sample: ChainSample): void {
  const placedAtUnix = sample.blockTimes.get(log.at.blockNumber) ?? draft.atUnix;
  putOrder(draft, {
    schemaVersion: SCHEMA_VERSION,
    id: log.id,
    owner: log.owner,
    side: log.side,
    sellAmount: log.sellAmount.toString(),
    minBuyAmount: log.minBuyAmount.toString(),
    recipient: log.recipient,
    expiresAfter: log.expiresAfter,
    state: "open",
    placedAtL2Block: log.at.blockNumber,
    placedAtUnix,
    windowId: log.windowId,
    rolledCount: 0,
    fill: null,
  });

  const window = draft.windows.get(log.windowId);
  if (window === undefined) return;
  if (window.orderIds.includes(log.id)) return;
  putWindow(draft, {
    ...window,
    orderIds: [...window.orderIds, log.id],
    grossIn: (BigInt(window.grossIn) + notionalInA(log.sellAmount, log.side, draft.priceX96)).toString(),
  });
}

function applyOrderFilled(
  draft: Draft,
  log: Extract<BookLog, { kind: "order_filled" }>,
  settled: ReadonlyMap<string, Extract<BookLog, { kind: "window_settled" }>>,
): void {
  const order = draft.orders.get(log.id);
  if (order === undefined) return;

  const settlement = settled.get(log.at.transactionHash);
  const residualSide =
    settlement === undefined
      ? null
      : residualSideFromResult(settlement.result.referencePriceX96, settlement.result.executionPriceX96);
  // Crossed volume never pays impact and never receives it (FL-5), so with the
  // residual side known the answer is exact; without it, an impact share of
  // zero is what the chain said about this fill and all it said.
  const crossed = residualSide === null ? log.impactAmount === 0n : order.side !== residualSide;
  const netIn = BigInt(order.sellAmount) - log.feeAmount - log.routeFeeAmount;

  moveOrder(draft, log.id, "filled", {
    fill: {
      windowId: order.windowId,
      amountOut: log.amountOut.toString(),
      feeAmount: log.feeAmount.toString(),
      routeFeeAmount: log.routeFeeAmount.toString(),
      impactAmount: log.impactAmount.toString(),
      priceX96: fillPriceX96(netIn, log.amountOut, order.side),
      crossed,
      settlementId: log.at.transactionHash,
    },
  });
}

function applyWindowSettled(
  draft: Draft,
  log: Extract<BookLog, { kind: "window_settled" }>,
  sample: ChainSample,
): void {
  const result = log.result;
  const residualSide = residualSideFromResult(result.referencePriceX96, result.executionPriceX96);
  const stampedAt = sample.blockTimes.get(log.at.blockNumber) ?? draft.atUnix;
  const window = draft.windows.get(log.windowId);
  const grossIn = window === undefined ? 0n : BigInt(window.grossIn);
  const residualInA = notionalInA(result.amountIn, residualSide ?? "SELL_A_FOR_B", result.referencePriceX96);

  moveWindow(draft, log.windowId, "settled", {
    syncL2Block: log.at.blockNumber,
    settlementId: log.at.transactionHash,
    residualIn: result.amountIn.toString(),
    residualSide,
    nettingRatio: nettingRatio(grossIn, residualInA),
  });

  const filled = [...draft.orders.values()]
    .filter((order) => order.fill?.settlementId === log.at.transactionHash)
    .map((order) => order.id)
    .sort();

  // The band and the deadline are built inside `settleWindow` and never
  // emitted (A.2). Zero is this gateway's "not observable from L2 alone"; the
  // settler's projection replaces it wherever that upstream is configured.
  const existing = draft.settlements.get(log.at.transactionHash);
  putSettlement(draft, {
    schemaVersion: SCHEMA_VERSION,
    id: log.at.transactionHash,
    windowId: log.windowId,
    outcome: "settled",
    leg: existing?.leg ?? {
      windowId: log.windowId,
      residualSide: residualSide ?? "SELL_A_FOR_B",
      residualIn: result.amountIn.toString(),
      minPriceX96: "0",
      maxPriceX96: "0",
      deadline: 0,
    },
    result: {
      amountIn: result.amountIn.toString(),
      amountOut: result.amountOut.toString(),
      referencePriceX96: result.referencePriceX96.toString(),
      executionPriceX96: result.executionPriceX96.toString(),
      post: result.post,
      l1Block: result.l1Block,
    },
    l1Receipt: existing?.l1Receipt ?? null,
    rollbackCause: null,
    l1GasSpent: existing?.l1GasSpent ?? false,
    filledOrderIds: filled,
    droppedOrderIds: existing?.droppedOrderIds ?? [],
    submittedAtUnix: existing?.submittedAtUnix ?? stampedAt,
    settledAtUnix: stampedAt,
    amortisation: null,
  });

  // A CT-6 refresh swaps nothing and exists only to re-stamp the mirror.
  const mirror: MirrorSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    windowId: log.windowId,
    state: result.post,
    referencePriceX96: result.referencePriceX96.toString(),
    l1Block: result.l1Block,
    mirrorTimestamp: stampedAt,
    ageSlots: 0,
    source: result.amountIn === 0n ? "refresh" : "settlement",
    observedAtUnix: draft.atUnix,
  };
  draft.mirror = mirror;
  event(draft, { kind: "mirror", mirror });

  // FL-8: what did not fill rolls into the next window, intact and open.
  const nextWindowId = (BigInt(log.windowId) + 1n).toString();
  for (const order of [...draft.orders.values()]) {
    if (order.windowId !== log.windowId) continue;
    if (order.state !== "open" && order.state !== "selected") continue;
    moveOrder(draft, order.id, "rolled", {
      windowId: nextWindowId,
      rolledCount: order.rolledCount + 1,
    });
  }
}

/** Folds `WindowBook`'s logs, in chain order, once each. */
function applyLogs(draft: Draft, sample: ChainSample): void {
  const settled = new Map<string, Extract<BookLog, { kind: "window_settled" }>>();
  for (const log of sample.logs) {
    if (log.kind === "window_settled") settled.set(log.at.transactionHash, log);
  }

  for (const log of sample.logs) {
    const key = `${log.at.blockNumber}:${log.at.logIndex}`;
    if (draft.seenLogs.has(key)) continue;
    draft.seenLogs.add(key);

    switch (log.kind) {
      case "order_placed":
        applyOrderPlaced(draft, log, sample);
        break;
      case "order_cancelled":
        moveOrder(draft, log.id, "cancelled");
        break;
      case "order_expired":
        moveOrder(draft, log.id, "expired");
        break;
      case "order_filled":
        applyOrderFilled(draft, log, settled);
        break;
      case "window_settled":
        applyWindowSettled(draft, log, sample);
        break;
    }
  }
}

/** Orders the gateway looked up because it was not running when they were placed. */
function applyResolved(draft: Draft, sample: ChainSample): void {
  for (const [id, order] of sample.resolved) {
    if (draft.orders.has(id)) continue;
    putOrder(draft, {
      schemaVersion: SCHEMA_VERSION,
      id,
      owner: order.owner,
      side: order.side,
      sellAmount: order.sellAmount.toString(),
      minBuyAmount: order.minBuyAmount.toString(),
      recipient: order.recipient,
      expiresAfter: order.expiresAfter,
      state: "open",
      placedAtL2Block: 0,
      placedAtUnix: draft.atUnix,
      windowId: sample.book?.windowId ?? draft.openWindowId ?? "0",
      rolledCount: 0,
      fill: null,
    });
  }
}

/** The clock ticks: L1 slots and L2 blocks, both events, never timers (FE-12). */
function applyTicks(draft: Draft, sample: ChainSample): void {
  if (sample.l1 !== null && sample.l1.head > draft.l1Block) {
    const windowId = draft.openWindowId ?? sample.book?.windowId ?? null;
    // The first observation is not history: a gateway that starts at block N
    // saw one boundary, not the N before it.
    const from = draft.l1Block === 0 ? sample.l1.head : Math.max(draft.l1Block + 1, sample.l1.head - MAX_CATCHUP_TICKS + 1);
    if (windowId !== null) {
      for (let block = from; block <= sample.l1.head; block++) {
        event(draft, { kind: "slot", l1Block: block, windowId });
      }
    }
    draft.l1Block = sample.l1.head;
  }

  if (sample.l2 !== null && sample.l2.head > draft.l2Block) {
    const windowId = draft.openWindowId ?? sample.book?.windowId ?? null;
    const remaining = sample.book?.blocksRemaining ?? 0;
    // Six L2 blocks to an L1 slot (RD-2 §1), one or two slots to a window (EC-6).
    const windowBlocks = (sample.book?.slots === 1 ? 1 : 2) * 6;
    const from = draft.l2Block === 0 ? sample.l2.head : Math.max(draft.l2Block + 1, sample.l2.head - MAX_CATCHUP_TICKS + 1);
    if (windowId !== null) {
      for (let block = from; block <= sample.l2.head; block++) {
        event(draft, {
          kind: "l2_block",
          l2Block: block,
          windowId,
          blocksRemaining: Math.min(windowBlocks - 1, Math.max(0, remaining + (sample.l2.head - block))),
        });
      }
    }
    draft.l2Block = sample.l2.head;
  }
}

/**
 * The mirror as the book holds it, when no settlement has restated it.
 *
 * Its age is the chain's own `(now - mirrorTimestamp) / 12` (CT-8), read from
 * `latestPrice()` rather than computed here, because the L1 head is not
 * visible from L2 and the book's answer is the only one a quote agrees with.
 */
function applyMirror(draft: Draft, sample: ChainSample): void {
  const view = sample.book;
  if (view === null || view.mirrorTimestamp === 0) return;

  const mirror: MirrorSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    windowId: view.windowId,
    state: view.mirror,
    referencePriceX96: view.referencePriceX96,
    l1Block: view.referenceL1Block,
    mirrorTimestamp: view.mirrorTimestamp,
    ageSlots: view.mirrorAgeSlots,
    source: draft.mirror === null ? "genesis" : draft.mirror.source,
    observedAtUnix: draft.atUnix,
  };

  if (draft.mirror !== null && sameMirror(draft.mirror, mirror)) return;
  draft.mirror = mirror;
  event(draft, { kind: "mirror", mirror });
}

function sameMirror(a: MirrorSnapshot, b: MirrorSnapshot): boolean {
  return (
    a.referencePriceX96 === b.referencePriceX96 &&
    a.l1Block === b.l1Block &&
    a.mirrorTimestamp === b.mirrorTimestamp &&
    a.ageSlots === b.ageSlots &&
    a.state.sqrtPriceX96 === b.state.sqrtPriceX96 &&
    a.state.liquidity === b.state.liquidity &&
    a.state.tick === b.state.tick
  );
}

/**
 * What only the settler can see: the selection, the band, evictions and
 * rollbacks (SV-4). Everything here is adopted, never inferred.
 */
function applySettler(draft: Draft, view: SettlerView): void {
  if (view.metrics !== null && JSON.stringify(view.metrics) !== JSON.stringify(draft.metrics)) {
    draft.metrics = view.metrics;
    event(draft, { kind: "metrics", metrics: view.metrics });
  }

  const selected = view.window?.selectedOrderIds ?? [];
  const window = view.window === null ? undefined : draft.windows.get(view.window.windowId);
  if (window !== undefined && JSON.stringify(window.selectedOrderIds) !== JSON.stringify(selected)) {
    putWindow(draft, { ...window, selectedOrderIds: [...selected] });
  }
  for (const id of selected) {
    const order = draft.orders.get(id);
    if (order !== undefined && order.state === "open") moveOrder(draft, id, "selected");
  }

  for (const entry of view.settlements) {
    if (entry.l1TxHash !== null) draft.l1TxHashes.set(entry.settlement.id, entry.l1TxHash);
    adoptSettlement(draft, entry.settlement);
  }
}

/** Adopts the settler's classification of a settlement, and its consequences. */
function adoptSettlement(draft: Draft, settled: Settlement): void {
  const known = draft.settlements.get(settled.id);
  const merged: Settlement = {
    ...settled,
    // The gateway's own reads win where it made them: it fetched the receipt
    // and computed IX-3 (`amortisation`) from it.
    l1Receipt: known?.l1Receipt ?? settled.l1Receipt,
    amortisation: known?.amortisation ?? settled.amortisation,
    result: settled.result ?? known?.result ?? null,
  };
  if (known !== undefined && JSON.stringify(known) === JSON.stringify(merged)) return;
  putSettlement(draft, merged);

  if (merged.outcome === "submitted") {
    moveWindow(draft, merged.windowId, "settling", { settlementId: merged.id });
    return;
  }
  if (merged.outcome === "settled") return;

  // FL-7: an eviction costs nothing and the window is open again, orders
  // intact. SV-4: a rollback un-happens the fills, which is a repair, not an
  // error — so the fills are undone before the window re-forms.
  if (merged.outcome === "rolled_back") {
    for (const order of [...draft.orders.values()]) {
      if (order.fill?.settlementId !== merged.id) continue;
      moveOrder(draft, order.id, "open", { fill: null });
    }
  }
  moveWindow(draft, merged.windowId, merged.outcome);
  moveWindow(draft, merged.windowId, "open", { settlementId: null, syncL2Block: null });
}

/** Attaches the L1 receipt and, with it, IX-3's figures. */
function applyReceipts(draft: Draft, sample: ChainSample): void {
  for (const [settlementId, txHash] of draft.l1TxHashes) {
    const settlement = draft.settlements.get(settlementId);
    const receipt = sample.receipts.get(txHash);
    if (settlement === undefined || receipt === undefined) continue;
    if (settlement.l1Receipt !== null && settlement.amortisation !== null) continue;

    const filled = settlement.filledOrderIds
      .map((id) => draft.orders.get(id))
      .filter((order): order is Order => order !== undefined)
      .map((order) => ({ id: order.id, owner: order.owner }));

    putSettlement(draft, {
      ...settlement,
      l1Receipt: {
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPriceWei: receipt.effectiveGasPriceWei.toString(),
        gasCostWei: (receipt.gasUsed * receipt.effectiveGasPriceWei).toString(),
        status: receipt.status,
      },
      amortisation: amortisationFor({
        settlementId: settlement.id,
        windowId: settlement.windowId,
        filled,
        receipt,
        sample: sample.gasSample,
      }),
    });
  }
}

/** One tick's observations, folded into the events that tick produced. */
export function foldSample(model: LiveModel, sample: ChainSample): {
  readonly model: LiveModel;
  readonly events: readonly SlotEvent[];
} {
  const draft = draftFrom(model, sample.atUnix);

  if (sample.book !== null) {
    const price = spotPriceX96(sample.book.mirror);
    if (price > 0n) draft.priceX96 = price;
    // Bootstrap only: a window discovered mid-tick opens after the settlement
    // that closed the last one, so the narrative stays in order.
    if (draft.windows.size === 0) {
      openWindow(draft, sample.book);
      draft.openWindowId = sample.book.windowId;
    }
  }

  applyTicks(draft, sample);
  applyLogs(draft, sample);
  if (sample.book !== null) {
    openWindow(draft, sample.book);
    draft.openWindowId = sample.book.windowId;
  }
  applyResolved(draft, sample);
  applyMirror(draft, sample);
  if (sample.settler !== null) applySettler(draft, sample.settler);
  draft.gasSample = sample.gasSample;
  applyReceipts(draft, sample);

  return { model: sealed(draft), events: draft.events };
}
