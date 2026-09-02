/**
 * The recorded run — RD-2 HX-5, IX-2, A.4.
 *
 * A pure fold from {@link ./observation.ts}'s raw facts to the frozen IX-2
 * `SlotEvent` stream. This is the file HX-5 is about: the JSON event log of
 * every window, order, settlement and mirror snapshot that Phase 5 replays
 * offline (FE-10), and it must be indistinguishable from what the indexer
 * serves live (IX-1, TS-5).
 *
 * Two rules it never breaks:
 *
 *   * **Every transition is one A.4 allows.** `canTransition` gates each state
 *     change and an illegal one throws here rather than reaching a reducer. A
 *     recorder that could emit `open -> settled` would let a fixture assert
 *     something the chain cannot do.
 *   * **Nothing is inferred that the chain did not say.** Fills and deductions
 *     come from the logs; the derived figures (netting, impact, amortisation)
 *     are computed by the same arithmetic the contracts use.
 */

import {
  ORDER_TRANSITIONS,
  SCHEMA_VERSION,
  WINDOW_TRANSITIONS,
  canTransition,
} from "../../indexer/schema/index.ts";
import type {
  Amortisation,
  Hash32,
  MirrorSnapshot,
  Order,
  OrderCounterfactual,
  OrderFill,
  OrderState,
  Settlement,
  SlotEvent,
  SlotEventKind,
  UnixSeconds,
  Window,
  WindowResult,
  WindowState,
} from "../../indexer/schema/index.ts";
import { Q96, fromBig, impactBps, mulDiv, nettingRatio, toBig } from "./math.ts";
import { MetricsRegistry } from "./metrics.ts";
import type { Observation, Profile } from "./observation.ts";

/** L2 blocks in one L1 slot: 12 s / 2 s (RD-2 §1). */
const BLOCKS_PER_SLOT = 6;

/** The L1 slot, in seconds — what mirror age is measured in (CT-8). */
const SLOT_SECONDS = 12;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type WorkingWindow = Mutable<Window> & {
  orderIds: Hash32[];
  selectedOrderIds: Hash32[];
};

type WorkingOrder = Mutable<Order>;

type WorkingSettlement = Mutable<Settlement> & {
  filledOrderIds: Hash32[];
  droppedOrderIds: Hash32[];
};

/** A fill seen before the `WindowSettled` that gives it its reference price. */
interface PendingFill {
  readonly id: Hash32;
  readonly amountOut: bigint;
  readonly feeAmount: bigint;
  readonly routeFeeAmount: bigint;
  readonly impactAmount: bigint;
}

/** The body of an event, before the recorder stamps its version and sequence. */
type EventBody = { readonly kind: SlotEventKind; readonly atUnix: UnixSeconds } & Record<string, unknown>;

/** What the recorder produced, and the profile the run was made under. */
export interface RecordedRun {
  readonly events: SlotEvent[];
  readonly profile: Profile;
}

class Recorder {
  private readonly events: SlotEvent[] = [];
  private readonly windows = new Map<string, WorkingWindow>();
  private readonly orders = new Map<Hash32, WorkingOrder>();
  private readonly settlements = new Map<Hash32, WorkingSettlement>();
  private readonly counterfactuals = new Map<Hash32, OrderCounterfactual>();
  private readonly pendingFills = new Map<Hash32, PendingFill[]>();

  private seq = 0;
  private atUnix = 0;
  private l2Block = 0;
  private currentWindowId = "0";
  private mirror: MirrorSnapshot | null = null;
  private previousMirror: MirrorSnapshot | null = null;
  profile: Profile = "full";

  fold(observations: readonly Observation[]): SlotEvent[] {
    for (const observation of observations) this.apply(observation);
    return this.events;
  }

  // --- emission -------------------------------------------------------------

  /**
   * Stamps and appends one event. The cast is the one place this file asserts
   * a shape rather than proving it: `SlotEvent` is a union discriminated on
   * `kind`, and every call site below builds exactly the arm its `kind` names.
   */
  private push(event: EventBody): void {
    this.seq += 1;
    this.events.push({ schemaVersion: SCHEMA_VERSION, seq: this.seq, ...event } as unknown as SlotEvent);
  }

  private emitWindow(window: WorkingWindow): void {
    this.push({ kind: "window", atUnix: this.atUnix, window: structuredClone(window) });
  }

  private emitOrder(order: WorkingOrder): void {
    this.push({ kind: "order", atUnix: this.atUnix, order: structuredClone(order) });
  }

  private emitSettlement(settlement: WorkingSettlement): void {
    this.push({ kind: "settlement", atUnix: this.atUnix, settlement: structuredClone(settlement) });
  }

  private emitMirror(mirror: MirrorSnapshot): void {
    this.push({ kind: "mirror", atUnix: this.atUnix, mirror: structuredClone(mirror) });
  }

  private emitMetrics(): void {
    this.push({ kind: "metrics", atUnix: this.atUnix, metrics: summarise(this.events).snapshot() });
  }

  // --- state machines -------------------------------------------------------

  private moveWindow(window: WorkingWindow, to: WindowState): void {
    if (window.state !== to && !canTransition(WINDOW_TRANSITIONS, window.state, to)) {
      throw new Error(`window ${window.windowId}: A.4 forbids ${window.state} -> ${to}`);
    }
    window.state = to;
  }

  private moveOrder(order: WorkingOrder, to: OrderState): void {
    if (order.state !== to && !canTransition(ORDER_TRANSITIONS, order.state, to)) {
      throw new Error(`order ${order.id}: A.4 forbids ${order.state} -> ${to}`);
    }
    order.state = to;
  }

  // --- lookups --------------------------------------------------------------

  private window(id: string): WorkingWindow {
    const window = this.windows.get(id);
    if (window === undefined) throw new Error(`no window ${id} has been observed`);
    return window;
  }

  private order(id: Hash32): WorkingOrder {
    const order = this.orders.get(id);
    if (order === undefined) throw new Error(`no order ${id} has been observed`);
    return order;
  }

  private settlement(id: Hash32): WorkingSettlement {
    const settlement = this.settlements.get(id);
    if (settlement === undefined) throw new Error(`no settlement ${id} has been observed`);
    return settlement;
  }

  private openWindow(id: string, slots: Window["slots"]): WorkingWindow {
    const window: WorkingWindow = {
      schemaVersion: SCHEMA_VERSION,
      windowId: id,
      state: "open",
      slots,
      openedAtL2Block: this.l2Block,
      openedAtUnix: this.atUnix,
      syncL2Block: null,
      orderIds: [],
      selectedOrderIds: [],
      settlementId: null,
      grossIn: "0",
      residualIn: "0",
      residualSide: null,
      nettingRatio: null,
    };
    this.windows.set(id, window);
    this.currentWindowId = id;
    return window;
  }

  // --- the fold -------------------------------------------------------------

  private apply(observation: Observation): void {
    this.atUnix = observation.at;

    switch (observation.kind) {
      case "genesis": {
        this.profile = observation.profile;
        this.l2Block = observation.l2Block;
        const window = this.openWindow(observation.windowId, observation.slots);
        this.emitWindow(window);
        this.setMirror({
          schemaVersion: SCHEMA_VERSION,
          windowId: observation.windowId,
          state: observation.mirror,
          referencePriceX96: observation.referencePriceX96,
          l1Block: observation.l1Block,
          mirrorTimestamp: observation.at,
          ageSlots: 0,
          source: "genesis",
          observedAtUnix: observation.at,
        });
        break;
      }

      case "l2_block": {
        this.l2Block = observation.l2Block;
        const window = this.window(this.currentWindowId);
        const end = window.openedAtL2Block + BLOCKS_PER_SLOT * window.slots;
        this.push({
          kind: "l2_block",
          atUnix: this.atUnix,
          l2Block: observation.l2Block,
          windowId: this.currentWindowId,
          blocksRemaining: Math.max(0, end - observation.l2Block),
        });
        break;
      }

      case "l1_slot":
        this.push({
          kind: "slot",
          atUnix: this.atUnix,
          l1Block: observation.l1Block,
          windowId: this.currentWindowId,
        });
        break;

      case "order_placed": {
        const window = this.window(observation.windowId);
        const order: WorkingOrder = {
          schemaVersion: SCHEMA_VERSION,
          id: observation.id,
          owner: observation.owner,
          side: observation.side,
          sellAmount: observation.sellAmount,
          minBuyAmount: observation.minBuyAmount,
          recipient: observation.recipient,
          expiresAfter: observation.expiresAfter,
          state: "open",
          placedAtL2Block: observation.l2Block,
          placedAtUnix: observation.at,
          windowId: observation.windowId,
          rolledCount: 0,
          fill: null,
        };
        this.orders.set(order.id, order);
        window.orderIds.push(order.id);
        window.grossIn = fromBig(toBig(window.grossIn) + this.inAUnits(order));
        this.emitOrder(order);
        this.emitWindow(window);
        break;
      }

      case "order_cancelled":
      case "order_expired": {
        const order = this.order(observation.id);
        const window = this.window(order.windowId);
        this.moveOrder(order, observation.kind === "order_cancelled" ? "cancelled" : "expired");
        const remaining = toBig(window.grossIn) - this.inAUnits(order);
        window.grossIn = fromBig(remaining < 0n ? 0n : remaining);
        this.emitOrder(order);
        this.emitWindow(window);
        break;
      }

      case "selection": {
        const window = this.window(observation.windowId);
        window.selectedOrderIds = [...observation.orderIds].sort();
        for (const id of window.selectedOrderIds) {
          const order = this.orders.get(id);
          if (order === undefined || order.state !== "open") continue;
          this.moveOrder(order, "selected");
          this.emitOrder(order);
        }
        this.emitWindow(window);
        break;
      }

      case "settlement_submitted": {
        const window = this.window(observation.windowId);
        this.moveWindow(window, "settling");
        window.syncL2Block = observation.l2Block;
        window.settlementId = observation.txHash;
        window.residualIn = observation.leg.residualIn;
        window.residualSide = observation.leg.residualSide;
        const settlement: WorkingSettlement = {
          schemaVersion: SCHEMA_VERSION,
          id: observation.txHash,
          windowId: observation.windowId,
          outcome: "submitted",
          leg: observation.leg,
          result: null,
          l1Receipt: null,
          rollbackCause: null,
          l1GasSpent: false,
          filledOrderIds: [],
          droppedOrderIds: [],
          submittedAtUnix: observation.at,
          settledAtUnix: null,
          amortisation: null,
        };
        this.settlements.set(settlement.id, settlement);
        this.emitWindow(window);
        this.emitSettlement(settlement);
        break;
      }

      case "order_filled": {
        // `_applyResult` emits every `OrderFilled` before the `WindowSettled`
        // that carries the reference price, so fills wait for it.
        const pending = this.pendingFills.get(observation.txHash) ?? [];
        pending.push({
          id: observation.id,
          amountOut: toBig(observation.amountOut),
          feeAmount: toBig(observation.feeAmount),
          routeFeeAmount: toBig(observation.routeFeeAmount),
          impactAmount: toBig(observation.impactAmount),
        });
        this.pendingFills.set(observation.txHash, pending);
        break;
      }

      case "window_settled":
        this.settle(observation.txHash, observation.windowId, observation.result, observation.l2Block);
        break;

      case "l1_receipt": {
        const settlement = this.settlement(observation.txHash);
        settlement.l1Receipt = observation.receipt;
        settlement.l1GasSpent = toBig(observation.receipt.gasUsed) > 0n;
        settlement.amortisation = this.amortise(settlement);
        this.emitSettlement(settlement);
        break;
      }

      case "settlement_evicted":
        this.evict(observation.windowId, observation.txHash);
        break;

      case "settlement_rolled_back":
        this.rollBack(observation.txHash, observation.cause, observation.l1GasSpent);
        break;

      case "counterfactual":
        this.counterfactuals.set(observation.orderId, {
          orderId: observation.orderId,
          gasUsed: observation.gasUsed,
          gasCostWei: observation.gasCostWei,
          source: observation.source,
        });
        break;
    }
  }

  // --- settlement -----------------------------------------------------------

  private settle(txHash: Hash32, windowId: string, result: WindowResult, l2Block: number): void {
    const settlement = this.settlement(txHash);
    const window = this.window(windowId);
    const p0 = toBig(result.referencePriceX96);

    const fills = this.pendingFills.get(txHash) ?? [];
    this.pendingFills.delete(txHash);

    let sumA = 0n;
    let sumB = 0n;
    for (const fill of fills) {
      const order = this.order(fill.id);
      const netIn = toBig(order.sellAmount) - fill.feeAmount - fill.routeFeeAmount;
      if (order.side === "SELL_A_FOR_B") sumA += netIn;
      else sumB += netIn;
    }

    settlement.outcome = "settled";
    settlement.result = result;
    settlement.settledAtUnix = this.atUnix;
    settlement.filledOrderIds = fills.map((fill) => fill.id).sort();
    settlement.droppedOrderIds = window.selectedOrderIds.filter(
      (id) => !settlement.filledOrderIds.includes(id),
    );

    for (const fill of fills) {
      const order = this.order(fill.id);
      const sideIsA = order.side === "SELL_A_FOR_B";
      const crossed = order.side !== settlement.leg.residualSide;
      const netIn = toBig(order.sellAmount) - fill.feeAmount - fill.routeFeeAmount;
      const orderFill: OrderFill = {
        windowId,
        amountOut: fromBig(fill.amountOut),
        feeAmount: fromBig(fill.feeAmount),
        routeFeeAmount: fromBig(fill.routeFeeAmount),
        impactAmount: fromBig(fill.impactAmount),
        priceX96: fromBig(fillPriceX96(sideIsA, netIn, fill.amountOut, p0, crossed)),
        crossed,
        settlementId: txHash,
      };
      order.fill = orderFill;
      this.moveOrder(order, "filled");
      this.emitOrder(order);
    }

    const grossInA = sumA + (p0 === 0n ? 0n : mulDiv(sumB, Q96, p0));
    const residualIn = toBig(settlement.leg.residualIn);
    const residualInA =
      settlement.leg.residualSide === "SELL_A_FOR_B" || p0 === 0n ? residualIn : mulDiv(residualIn, Q96, p0);

    this.moveWindow(window, "settled");
    window.syncL2Block = l2Block;
    window.grossIn = fromBig(grossInA);
    window.residualIn = settlement.leg.residualIn;
    window.residualSide = settlement.leg.residualSide;
    window.nettingRatio = nettingRatio(grossInA, residualInA);

    // The settlement first, then the window: a reader that counts a window's
    // outcome needs the settlement's fills to tell a settled window from an
    // empty CT-6 refresh.
    this.emitSettlement(settlement);
    this.emitWindow(window);

    this.setMirror({
      schemaVersion: SCHEMA_VERSION,
      windowId,
      state: result.post,
      referencePriceX96: result.referencePriceX96,
      l1Block: result.l1Block,
      mirrorTimestamp: this.atUnix,
      ageSlots: 0,
      source: residualIn === 0n ? "refresh" : "settlement",
      observedAtUnix: this.atUnix,
    });

    // The next window opens with the orders that did not fill, intact (FL-8).
    const rolled = window.orderIds.filter((id) => {
      const state = this.order(id).state;
      return state === "open" || state === "selected";
    });
    for (const id of rolled) {
      const order = this.order(id);
      this.moveOrder(order, "rolled");
      this.emitOrder(order);
    }

    const next = this.openWindow(fromBig(toBig(windowId) + 1n), window.slots);
    for (const id of rolled) {
      const order = this.order(id);
      this.moveOrder(order, "open");
      order.windowId = next.windowId;
      order.rolledCount += 1;
      next.orderIds.push(id);
      next.grossIn = fromBig(toBig(next.grossIn) + this.inAUnits(order));
      this.emitOrder(order);
    }
    this.emitWindow(next);
    this.emitMetrics();
  }

  // --- the two failures -----------------------------------------------------

  /**
   * Poison eviction (FL-7): the composed transaction reverted at compose time,
   * so no L1 transaction ever existed. The window returns to `open` with every
   * order intact and no receipt is ever attached — which is what makes free
   * failure legible in the stream rather than a footnote.
   */
  private evict(windowId: string, txHash: Hash32 | null): void {
    const window = this.window(windowId);
    if (txHash !== null) {
      const settlement = this.settlement(txHash);
      settlement.outcome = "evicted";
      settlement.l1Receipt = null;
      settlement.l1GasSpent = false;
      this.emitSettlement(settlement);
    }
    this.moveWindow(window, "evicted");
    this.emitWindow(window);

    for (const id of window.selectedOrderIds) {
      const order = this.orders.get(id);
      if (order === undefined || order.state !== "selected") continue;
      this.moveOrder(order, "open");
      this.emitOrder(order);
    }
    window.selectedOrderIds = [];
    window.settlementId = null;
    window.syncL2Block = null;
    window.residualIn = "0";
    window.residualSide = null;
    this.moveWindow(window, "open");
    this.currentWindowId = windowId;
    this.emitWindow(window);
    this.emitMetrics();
  }

  /**
   * Rollback (SV-4): the L2 blocks un-happen. Fills are undone, the mirror the
   * settlement adopted goes with them, and the window re-forms. The one cause
   * that spent L1 gas is `postbatch_skip`, and it is carried through rather
   * than smoothed over — it is the only rollback that is not free.
   */
  private rollBack(txHash: Hash32, cause: Settlement["rollbackCause"], l1GasSpent: boolean): void {
    const settlement = this.settlement(txHash);
    const window = this.window(settlement.windowId);

    settlement.outcome = "rolled_back";
    settlement.rollbackCause = cause;
    settlement.l1GasSpent = l1GasSpent;
    this.emitSettlement(settlement);

    this.moveWindow(window, "rolled_back");
    this.emitWindow(window);

    for (const id of settlement.filledOrderIds) {
      const order = this.order(id);
      this.moveOrder(order, "open");
      order.fill = null;
      this.emitOrder(order);
    }
    for (const id of window.selectedOrderIds) {
      const order = this.orders.get(id);
      if (order === undefined || order.state !== "selected") continue;
      this.moveOrder(order, "open");
      this.emitOrder(order);
    }

    // The window the settlement opened un-happens with it. Orders that rolled
    // into it un-roll; orders placed in its blocks belong to the re-formed
    // window, which is where the book will hold them once the L2 blocks are
    // rebuilt.
    const nextId = fromBig(toBig(settlement.windowId) + 1n);
    const next = this.windows.get(nextId);
    if (next !== undefined) {
      for (const id of next.orderIds) {
        const order = this.order(id);
        order.windowId = window.windowId;
        if (window.orderIds.includes(id)) {
          if (order.rolledCount > 0) order.rolledCount -= 1;
        } else {
          window.orderIds.push(id);
        }
        this.emitOrder(order);
      }
      this.windows.delete(nextId);
    }

    window.selectedOrderIds = [];
    window.settlementId = null;
    window.syncL2Block = null;
    window.nettingRatio = null;
    window.residualIn = "0";
    window.residualSide = null;
    this.moveWindow(window, "open");
    this.currentWindowId = window.windowId;
    this.emitWindow(window);

    this.restoreMirror();
    this.emitMetrics();
  }

  // --- derived --------------------------------------------------------------

  private setMirror(mirror: MirrorSnapshot): void {
    if (this.mirror !== null) this.previousMirror = this.mirror;
    this.mirror = {
      ...mirror,
      ageSlots: Math.max(0, Math.floor((this.atUnix - mirror.mirrorTimestamp) / SLOT_SECONDS)),
    };
    this.emitMirror(this.mirror);
  }

  /** The mirror a rolled-back settlement adopted un-happens with it. */
  private restoreMirror(): void {
    if (this.previousMirror === null) return;
    this.mirror = {
      ...this.previousMirror,
      ageSlots: Math.max(0, Math.floor((this.atUnix - this.previousMirror.mirrorTimestamp) / SLOT_SECONDS)),
      observedAtUnix: this.atUnix,
    };
    this.previousMirror = null;
    this.emitMirror(this.mirror);
  }

  /**
   * An order's volume in A units, so a window's `grossIn` is one number rather
   * than a sum of two assets. Converted at the mirror the window was quoted
   * against, which is the price its netting ratio is measured at.
   */
  private inAUnits(order: WorkingOrder): bigint {
    const amount = toBig(order.sellAmount);
    if (order.side === "SELL_A_FOR_B") return amount;
    const price = this.mirror === null ? 0n : toBig(this.mirror.referencePriceX96);
    return price === 0n ? 0n : mulDiv(amount, Q96, price);
  }

  /**
   * IX-3's amortisation. The counterfactual per order is the gas that order's
   * own address last paid for a swap on L1 when the run observed one, else the
   * median of the ones it did observe — never a fixed estimate, which IX-3
   * forbids because a made-up denominator makes the saving a made-up number.
   */
  private amortise(settlement: WorkingSettlement): Amortisation | null {
    const receipt = settlement.l1Receipt;
    if (receipt === null || this.counterfactuals.size === 0) return null;

    const observed = [...this.counterfactuals.values()];
    const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
    const costs = observed.map((entry) => toBig(entry.gasCostWei)).sort(ascending);
    const used = observed.map((entry) => toBig(entry.gasUsed)).sort(ascending);
    const medianCost = costs[Math.floor((costs.length - 1) / 2)] ?? 0n;
    const medianUsed = used[Math.floor((used.length - 1) / 2)] ?? 0n;

    const perOrder: OrderCounterfactual[] = settlement.filledOrderIds.map(
      (id) =>
        this.counterfactuals.get(id) ?? {
          orderId: id,
          gasUsed: fromBig(medianUsed),
          gasCostWei: fromBig(medianCost),
          source: "median_retail_swap",
        },
    );

    const fills = settlement.filledOrderIds.length;
    const l1GasCostWei = toBig(receipt.gasCostWei);
    const counterfactual = perOrder.reduce((total, entry) => total + toBig(entry.gasCostWei), 0n);

    return {
      schemaVersion: SCHEMA_VERSION,
      settlementId: settlement.id,
      windowId: settlement.windowId,
      fills,
      l1GasUsed: receipt.gasUsed,
      l1GasCostWei: receipt.gasCostWei,
      gasPerFillWei: fills === 0 ? null : fromBig(l1GasCostWei / BigInt(fills)),
      counterfactualGasCostWei: fromBig(counterfactual),
      savingsWei: (counterfactual - l1GasCostWei).toString(10),
      perOrder,
    };
  }
}

/**
 * The price one fill cleared at (FL-5): the window's `referencePriceX96` if it
 * crossed, that price less its impact share if it was on the residual side.
 * The residual figure is recomputed from the fill rather than taken on trust,
 * which is what makes it something the chain can fail.
 */
export function fillPriceX96(
  sideIsA: boolean,
  netIn: bigint,
  amountOut: bigint,
  p0: bigint,
  crossed: boolean,
): bigint {
  if (crossed) return p0;
  if (sideIsA) return netIn === 0n ? 0n : mulDiv(amountOut, Q96, netIn);
  return amountOut === 0n ? 0n : mulDiv(netIn, Q96, amountOut);
}

/**
 * Folds a stream into the A.5 registry — see {@link ./metrics.ts} for why the
 * scenario derives these rather than reading the settler's own registry.
 */
export function summarise(events: readonly SlotEvent[]): MetricsRegistry {
  const registry = new MetricsRegistry();
  const settlements = new Map<Hash32, Settlement>();
  const orders = new Map<Hash32, Order>();
  const counted = new Set<string>();
  let mirrorTimestamp: UnixSeconds | null = null;
  let rolled = 0;

  for (const event of events) {
    switch (event.kind) {
      case "order":
        orders.set(event.order.id, event.order);
        break;

      case "mirror":
        mirrorTimestamp = event.mirror.mirrorTimestamp;
        registry.set("mirror_age_slots", event.mirror.ageSlots);
        break;

      case "slot":
        if (mirrorTimestamp !== null) {
          registry.set("mirror_age_slots", Math.max(0, Math.floor((event.atUnix - mirrorTimestamp) / SLOT_SECONDS)));
        }
        break;

      case "window": {
        const window = event.window;
        registry.set("window_slots", window.slots);
        const key = `${window.windowId}:${window.state}`;
        if (!counted.has(key)) {
          if (window.state === "settled") {
            counted.add(key);
            const settlement = window.settlementId === null ? undefined : settlements.get(window.settlementId);
            registry.recordWindow((settlement?.filledOrderIds.length ?? 0) === 0 ? "empty" : "settled");
          } else if (window.state === "evicted" || window.state === "rolled_back") {
            counted.add(key);
            registry.recordWindow(window.state);
          }
        }
        if (window.state === "settled" && window.nettingRatio !== null) {
          registry.observe("netting_ratio", window.nettingRatio);
        }
        break;
      }

      case "settlement": {
        const settlement = event.settlement;
        const previous = settlements.get(settlement.id);
        settlements.set(settlement.id, settlement);
        if (settlement.outcome === "settled" && previous?.outcome !== "settled") {
          registry.observe("fills_per_settlement", settlement.filledOrderIds.length);
          if (settlement.result !== null) {
            registry.observe(
              "impact_bps",
              impactBps(toBig(settlement.result.referencePriceX96), toBig(settlement.result.executionPriceX96)),
            );
          }
          if (settlement.settledAtUnix !== null) {
            registry.observe("time_to_settle_seconds", settlement.settledAtUnix - settlement.submittedAtUnix);
          }
        }
        if (settlement.amortisation !== null && previous?.amortisation === null) {
          const amortisation = settlement.amortisation;
          if (amortisation.gasPerFillWei !== null) {
            registry.observe("gas_per_fill_wei", Number(toBig(amortisation.gasPerFillWei)));
          }
          if (amortisation.fills > 0) {
            registry.observe(
              "counterfactual_l1_gas_wei",
              Number(toBig(amortisation.counterfactualGasCostWei) / BigInt(amortisation.fills)),
            );
          }
        }
        break;
      }

      default:
        break;
    }
  }

  for (const order of orders.values()) if (order.rolledCount > 0) rolled += 1;
  registry.set("roll_rate", orders.size === 0 ? 0 : rolled / orders.size);
  // The two invariants are asserted against the chain rather than derived from
  // the stream, and published at zero so a reader sees them present (A.5).
  registry.set("unposted_window", 0);
  registry.set("escrow_invariant_drift_wei", 0);
  registry.increment("selection_omitted_total", 0);

  return registry;
}

/** Folds an observation log into the IX-2 stream Phase 5 replays (HX-5). */
export function record(observations: readonly Observation[]): RecordedRun {
  const recorder = new Recorder();
  const events = recorder.fold(observations);
  return { events, profile: recorder.profile };
}
