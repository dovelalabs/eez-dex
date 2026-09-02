/**
 * The views the components render — RD-2 FE-2 … FE-8.
 *
 * Derived state lives here rather than in components so that what a view shows
 * can be tested as a value, and so that two views cannot derive the same fact
 * two ways. Where the stream already carries a number — a fill's price, a
 * window's netting ratio, IX-3's counterfactual — these functions *select* it;
 * they do not recompute it (FE-3, FE-6). Where a figure is a sum of stream
 * numbers, that is said in the doc comment and the sum is done once.
 */

import type {
  ActivityState,
  Amortisation,
  CounterfactualSource,
  Order,
  Settlement,
  Side,
  Window,
} from "@eez-dex/indexer";
import type { MirrorSnapshot } from "@eez-dex/indexer/schema";

import { L1_SLOT_SECONDS, L2_BLOCKS_PER_SLOT, L2_BLOCK_SECONDS, valueIn } from "../domain/mirror.ts";
import { differenceBps, spotPriceX96 } from "../domain/q96.ts";
import type { AppState } from "./app.ts";
import type { Transition } from "./chain.ts";

/**
 * What the stream is carrying, by the gateway's own definitions.
 *
 * When there is a gateway its answer is used verbatim. A local replay has no
 * gateway, so the same rule is applied here to the same data — `loading`
 * before anything is observed, `empty` when the open window holds no orders,
 * `ended` at the end of a recording. It is the gateway's rule, not a second
 * one (IX-1, §7 preamble).
 */
export function activity(state: AppState): ActivityState {
  if (state.status !== null) return state.status.activity;
  if (state.replay?.ended === true) return "ended";
  if (state.chain.events === 0) return "loading";
  return openOrders(state).length === 0 ? "empty" : "active";
}

/** The open window, if one has been observed. */
export function openWindow(state: AppState): Window | null {
  const id = state.chain.openWindowId;
  return id === null ? null : (state.chain.windows.get(id) ?? null);
}

/** The most recent window in observation order — open or not. */
export function latestWindow(state: AppState): Window | null {
  const id = state.chain.windowIds[state.chain.windowIds.length - 1];
  return id === undefined ? null : (state.chain.windows.get(id) ?? null);
}

/** The window the theater draws: the open one, else the last one seen. */
export function theaterWindow(state: AppState): Window | null {
  return openWindow(state) ?? latestWindow(state);
}

/** Every order the stream has reported for a window, in placement order. */
export function ordersOf(state: AppState, windowId: string): readonly Order[] {
  return state.chain.orderIds
    .map((id) => state.chain.orders.get(id))
    .filter((order): order is Order => order !== undefined && order.windowId === windowId);
}

/** Orders still live in the open window — the count a quiet chain reports zero. */
export function openOrders(state: AppState): readonly Order[] {
  const id = state.chain.openWindowId;
  if (id === null) return [];
  return ordersOf(state, id).filter((order) => order.state === "open" || order.state === "selected");
}

/** The settlement that closed a window, if there is one. */
export function settlementOf(state: AppState, window: Window | null): Settlement | null {
  if (window === null || window.settlementId === null) return null;
  return state.chain.settlements.get(window.settlementId) ?? null;
}

/**
 * The settlement the theater's L1 lane draws.
 *
 * The drawn window's own, when it has one — and otherwise the most recent
 * settlement there is, because that is the one whose residual has just
 * descended. An evicted or rolled-back window returns to `open` with its
 * orders intact (A.4), so at the moment those outcomes matter most the window
 * on screen is open again and the settlement is the only thing that still
 * carries what happened (FE-5, FE-7).
 */
export function laneSettlement(state: AppState, window: Window | null): Settlement | null {
  return settlementOf(state, window) ?? latestSettlement(state);
}

/** The most recent settlement the stream reported. */
export function latestSettlement(state: AppState): Settlement | null {
  const id = state.chain.settlementIds[state.chain.settlementIds.length - 1];
  return id === undefined ? null : (state.chain.settlements.get(id) ?? null);
}

/** The two sides of a window, as the theater draws them (FE-5). */
export interface WindowSides {
  /** Σ sell amounts on the A side, in A. */
  readonly sellA: bigint;
  /** Σ sell amounts on the B side, in B. */
  readonly sellB: bigint;
  /** The B side valued in A at the mirror price, so the bars are comparable. */
  readonly sellBInA: bigint;
  /** What crosses, in A — `min` of the two, FL-4's rule at the mirror price. */
  readonly crossedInA: bigint;
  /** What is left over, in A, and which way it trades. */
  readonly residualInA: bigint;
  readonly residualSide: Side | null;
  /**
   * True once the window has closed and these are the chain's own figures
   * rather than the mirror-priced indication the theater draws mid-window
   * (FL-4 fixes the cross at the mirror price the leg was built against).
   */
  readonly settled: boolean;
  readonly orders: readonly Order[];
}

/**
 * The cross, as far as it can honestly be known.
 *
 * Mid-window this is *indicative*: the sides are the orders the stream has
 * reported, valued at the mirror the leg would be built against, which is the
 * same rule `_buildLeg` applies (CT-9) but against a mirror that may yet move.
 * Once the window closes, the window's own `residualIn` and `nettingRatio` are
 * used instead — the chain's numbers, not this app's.
 */
export function windowSides(state: AppState, window: Window | null): WindowSides | null {
  if (window === null) return null;
  const orders = ordersOf(state, window.windowId);
  const mirrorPrice = state.chain.mirror === null ? 0n : spotPriceX96(state.chain.mirror.state);

  let sellA = 0n;
  let sellB = 0n;
  for (const order of orders) {
    if (order.state === "cancelled" || order.state === "expired") continue;
    if (order.side === "SELL_A_FOR_B") sellA += BigInt(order.sellAmount);
    else sellB += BigInt(order.sellAmount);
  }
  const sellBInA = mirrorPrice === 0n || sellB === 0n ? 0n : valueIn(sellB, mirrorPrice, "SELL_B_FOR_A");

  const closed = window.state !== "open" && window.residualSide !== null;
  if (closed) {
    const residual = BigInt(window.residualIn);
    const residualInA =
      window.residualSide === "SELL_A_FOR_B" || mirrorPrice === 0n
        ? residual
        : valueIn(residual, mirrorPrice, "SELL_B_FOR_A");
    const gross = BigInt(window.grossIn);
    return {
      sellA,
      sellB,
      sellBInA,
      crossedInA: gross > residualInA ? gross - residualInA : 0n,
      residualInA,
      residualSide: window.residualSide,
      settled: true,
      orders,
    };
  }

  const crossedInA = sellA < sellBInA ? sellA : sellBInA;
  const residualInA = sellA > sellBInA ? sellA - sellBInA : sellBInA - sellA;
  return {
    sellA,
    sellB,
    sellBInA,
    crossedInA,
    residualInA,
    residualSide: residualInA === 0n ? null : sellA > sellBInA ? "SELL_A_FOR_B" : "SELL_B_FOR_A",
    settled: false,
    orders,
  };
}

/** The slot clock, anchored on the last event rather than on a timer (FE-12). */
export interface SlotClock {
  /** Seconds into the window, by the source's clock. */
  readonly elapsed: number;
  /** The window's length in seconds — `12 × slots` (EC-6). */
  readonly total: number;
  /** `elapsed / total`, clamped: the progress bar's own figure. */
  readonly ratio: number;
  /**
   * L2 blocks this window has actually been *told* about, and how many it
   * holds. Zero until an `l2_block` event arrives for this window: a block the
   * stream has not reported is a block that has not been produced, and
   * inferring one from elapsed time would be the synthetic tick FE-12 forbids.
   */
  readonly blocks: number;
  readonly blocksTotal: number;
  /**
   * True when the chain has produced nothing for longer than an L2 block
   * allows. A stalled chain is a visibly stalled window, never an animation
   * that keeps playing (FE-12).
   */
  readonly stalled: boolean;
  /** Seconds since the last event of any kind. */
  readonly sinceLastEvent: number;
}

/** How long a chain may say nothing before the window is visibly stalled. */
export const STALL_SECONDS = L2_BLOCK_SECONDS * 3;

/** The window's clock. Null before a window has been observed. */
export function slotClock(state: AppState, window: Window | null): SlotClock | null {
  if (window === null) return null;
  const total = L1_SLOT_SECONDS * window.slots;
  const blocksTotal = L2_BLOCKS_PER_SLOT * window.slots;
  const elapsed = Math.max(0, state.nowUnix - window.openedAtUnix);
  const remaining = state.chain.block?.windowId === window.windowId ? state.chain.block.blocksRemaining : null;
  const sinceLastEvent = Math.max(0, state.nowUnix - state.chain.atUnix);

  return {
    elapsed,
    total,
    ratio: total === 0 ? 0 : Math.min(1, elapsed / total),
    blocks: remaining === null ? 0 : Math.max(0, Math.min(blocksTotal, blocksTotal - remaining)),
    blocksTotal,
    stalled: window.state === "open" && sinceLastEvent > STALL_SECONDS,
    sinceLastEvent,
  };
}

/** The mirror against the L1 head — FE-7's gap and FE-8's comparison. */
export interface Drift {
  readonly mirrorPriceX96: bigint;
  readonly l1PriceX96: bigint;
  /** The mirror's distance from the head, signed, in basis points. */
  readonly bps: number;
  readonly l1Block: number;
  readonly observedAtUnix: number;
}

/**
 * The drift, when both sides of the comparison are actually known.
 *
 * The L1 head's own pool state rides in the gateway's envelope (IX-1); a
 * replay has none, and no adapter configured is a legitimate deployment. Null
 * is the honest answer in both cases — the theater says the head is not
 * observable rather than drawing a gap of zero.
 */
export function drift(state: AppState): Drift | null {
  const pool = state.status?.l1Pool ?? null;
  const mirror = state.chain.mirror;
  if (pool === null || mirror === null) return null;

  const mirrorPriceX96 = spotPriceX96(mirror.state);
  const l1PriceX96 = spotPriceX96(pool.state);
  const bps = differenceBps(mirrorPriceX96, l1PriceX96);
  if (bps === null) return null;
  return { mirrorPriceX96, l1PriceX96, bps, l1Block: pool.l1Block, observedAtUnix: pool.observedAtUnix };
}

/** The mirror's age in slots right now, by the source's clock (CT-8, FL-2). */
export function mirrorAgeSlots(state: AppState, mirror: MirrorSnapshot | null = state.chain.mirror): number | null {
  if (mirror === null) return null;
  if (state.nowUnix <= mirror.mirrorTimestamp) return mirror.ageSlots;
  return Math.floor((state.nowUnix - mirror.mirrorTimestamp) / L1_SLOT_SECONDS);
}

/** Orders that rolled at a window's boundary — FL-8 as a picture (FE-7). */
export function rolledAt(state: AppState, windowId: string): readonly Order[] {
  const rolled = new Set(
    state.chain.transitions
      .filter((transition) => transition.subject === "order" && transition.to === "rolled" && transition.windowId === windowId)
      .map((transition) => transition.id),
  );
  return [...rolled].map((id) => state.chain.orders.get(id)).filter((order): order is Order => order !== undefined);
}

/** Transitions A.4 does not allow — a defect upstream, shown as one (FE-7). */
export function illegalTransitions(state: AppState): readonly Transition[] {
  return state.chain.transitions.filter((transition) => !transition.legal);
}

/** FE-6's cumulative half: the sum of the per-settlement figures IX-3 computed. */
export interface Cumulative {
  readonly settlements: number;
  readonly fills: number;
  readonly l1GasCostWei: bigint;
  readonly counterfactualGasCostWei: bigint;
  readonly savingsWei: bigint;
  readonly gasPerFillWei: bigint | null;
  /** Fills per L1 transaction, the headline of the counter. */
  readonly fillsPerSettlement: number | null;
}

/**
 * Sums IX-3's per-settlement figures.
 *
 * The addition is the only arithmetic here, and it is the same addition the
 * gateway does for its snapshot — kept local because a scrubbed-back view must
 * total what it is showing rather than what the stream has since reached.
 */
export function cumulativeAmortisation(state: AppState): Cumulative {
  let fills = 0;
  let l1 = 0n;
  let counterfactual = 0n;
  let settlements = 0;

  // A rolled-back settlement contributes its gas and not its fills: the
  // `postBatch` skip is the one rollback that is not free, and the fills it
  // claimed were undone (SV-4, A.4) — this reducer has already put those
  // orders back to pending. The gateway sums it the same way (IX-3).
  for (const id of state.chain.settlementIds) {
    const settlement = state.chain.settlements.get(id);
    const entry = settlement?.amortisation;
    if (settlement === undefined || entry === null || entry === undefined) continue;
    settlements += 1;
    l1 += BigInt(entry.l1GasCostWei);
    if (settlement.outcome === "rolled_back") continue;
    fills += entry.fills;
    counterfactual += BigInt(entry.counterfactualGasCostWei);
  }

  return {
    settlements,
    fills,
    l1GasCostWei: l1,
    counterfactualGasCostWei: counterfactual,
    savingsWei: counterfactual - l1,
    gasPerFillWei: fills === 0 ? null : l1 / BigInt(fills),
    fillsPerSettlement: settlements === 0 ? null : fills / settlements,
  };
}

/** Every settlement's IX-3 figures, oldest first. */
export function amortisations(state: AppState): readonly Amortisation[] {
  return state.chain.settlementIds
    .map((id) => state.chain.settlements.get(id)?.amortisation ?? null)
    .filter((entry): entry is Amortisation => entry !== null);
}

/** IX-3's counterfactual for one address, and which of the two sources it is. */
export interface UserCounterfactual {
  readonly gasCostWei: bigint;
  readonly source: CounterfactualSource;
}

/**
 * The direct-L1 comparison to put beside a quote (FE-3).
 *
 * IX-3 attaches a counterfactual to every filled order, from one of exactly
 * two sources. This picks the most recent one belonging to the connected
 * address — the only figure FE-3 may render as "your last L1 swap cost" — and
 * falls back to the most recent sampled median. When the stream carries
 * neither, the answer is null and the cost line says the comparison has not
 * been observed rather than inventing a denominator (IX-3).
 */
export function counterfactualFor(state: AppState, address: string | null): UserCounterfactual | null {
  const owned = address === null ? null : new Set(
    state.chain.orderIds
      .map((id) => state.chain.orders.get(id))
      .filter((order): order is Order => order !== undefined && order.owner.toLowerCase() === address.toLowerCase())
      .map((order) => order.id),
  );

  let chosen: UserCounterfactual | null = null;
  for (const entry of amortisations(state)) {
    for (const perOrder of entry.perOrder) {
      if (perOrder.source === "user_last_l1_swap" && owned?.has(perOrder.orderId) === true) {
        chosen = { gasCostWei: BigInt(perOrder.gasCostWei), source: "user_last_l1_swap" };
      } else if (perOrder.source === "median_retail_swap" && chosen?.source !== "user_last_l1_swap") {
        chosen = { gasCostWei: BigInt(perOrder.gasCostWei), source: "median_retail_swap" };
      }
    }
  }
  return chosen;
}

/** One line of FE-4's history: a fill, with the settlement that produced it. */
export interface FilledOrder {
  readonly order: Order;
  readonly settlement: Settlement | null;
}

/** The connected address's orders, newest first. */
export function ordersOwnedBy(state: AppState, address: string | null): readonly Order[] {
  if (address === null) return [];
  const owner = address.toLowerCase();
  return state.chain.orderIds
    .map((id) => state.chain.orders.get(id))
    .filter((order): order is Order => order !== undefined && order.owner.toLowerCase() === owner)
    .reverse();
}

/** Their open orders — the ones FE-4 offers a cancel for. */
export function openOrdersOwnedBy(state: AppState, address: string | null): readonly Order[] {
  return ordersOwnedBy(state, address).filter((order) => order.state === "open" || order.state === "selected");
}

/** Their fill history, with each settlement attached for its L1 link (FE-4). */
export function historyOwnedBy(state: AppState, address: string | null): readonly FilledOrder[] {
  return ordersOwnedBy(state, address)
    .filter((order) => order.fill !== null)
    .map((order) => ({
      order,
      settlement: order.fill === null ? null : (state.chain.settlements.get(order.fill.settlementId) ?? null),
    }));
}

/** How the theater treats a window's ending — FE-7 gives each its own (FE-5). */
export const OUTCOME_TREATMENTS = ["open", "settling", "settled", "evicted", "rolled_back"] as const;

/** One of them. */
export type OutcomeTreatment = (typeof OUTCOME_TREATMENTS)[number];

/** What the theater should be drawing for a window right now. */
export function treatmentOf(window: Window | null): OutcomeTreatment {
  return window === null ? "open" : window.state;
}
