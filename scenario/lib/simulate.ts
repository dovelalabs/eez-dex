/**
 * A window, driven — RD-2 HX-5, and the scaffolding the fixtures are built on.
 *
 * The enclave is the real article: `dex-scenario.sh` brings it up, places real
 * orders from real accounts, and the settler settles them. What this file does
 * is produce the *same observations* from the settlement oracle, so that
 *
 *   * the recorded run (HX-5) can be regenerated and checked without an
 *     enclave, which is what lets Phase 5 be built in parallel, and
 *   * the recorder and the assertions are exercised over every A.4 outcome —
 *     settled, rolled, evicted, rolled back — on every `make check`, not only
 *     on the nights the full matrix runs.
 *
 * It is not a second settler. It computes nothing the chain would not: the
 * fills come from {@link ./book.ts}, the swap from {@link ./pool.ts}, and the
 * selection from the same inclusion-maximal search the audit uses.
 */

import { SettlementRevert, expectSettlement, selectFillable } from "./book.ts";
import type { BookOrder, BookParams } from "./book.ts";
import { fromBig, spotPriceX96 } from "./math.ts";
import { keccak256Utf8, orderId } from "./keccak.ts";
import type { Pool } from "./pool.ts";
import { toPoolState } from "./pool.ts";
import type { Observation, Profile } from "./observation.ts";
import type { Hash32, Side, WindowSlots } from "../../indexer/schema/index.ts";

/** L2 blocks in one L1 slot. */
const BLOCKS_PER_SLOT = 6;

/** The L2 block time, in seconds. */
const L2_BLOCK_SECONDS = 2;

/** What one L1 leg costs, as the devnet measures it. */
export interface GasModel {
  /** Gas the settlement transaction uses before any fill. */
  readonly base: bigint;
  /** Additional gas per fill. */
  readonly perFill: bigint;
  /** The effective gas price, in wei. */
  readonly priceWei: bigint;
  /** What one direct L1 swap costs the same user — ER-2's ~400k (IX-3). */
  readonly directSwap: bigint;
}

/** The per-asset CT-13 ledger the book keeps, as the simulation mirrors it. */
export interface AssetLedger {
  escrowed: bigint;
  feesAccrued: bigint;
  dustAccrued: bigint;
  credited: bigint;
  deposits: bigint;
  released: bigint;
  withdrawn: bigint;
}

/** The simulation's starting conditions. */
export interface SimulationOptions {
  /** A's L2 address. `0x0…0` is native zone ETH in the full form (CT-11). */
  readonly assetA?: string;
  /** B's L2 address. */
  readonly assetB?: string;
  readonly profile: Profile;
  readonly params: BookParams;
  readonly pool: Pool;
  readonly startUnix: number;
  readonly startL1Block: number;
  readonly startL2Block: number;
  readonly windowSlots: WindowSlots;
  readonly gas: GasModel;
}

/** An order as the simulation places it. */
export interface PlacedOrder extends BookOrder {
  readonly owner: string;
  readonly recipient: string;
  readonly expiresAfter: number;
  /**
   * The window it was placed in, fixed for its whole life. Expiry is measured
   * from here (`currentWindow > placedWindow + expiresAfter`), not from the
   * window it currently belongs to — an order that rolls does not get a longer
   * life for having rolled.
   */
  readonly placedWindow: string;
}

/** How a window ends. */
export type WindowOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "evicted"; readonly reason: string }
  | { readonly kind: "rolled_back"; readonly cause: "bundle_missed" | "reorg" | "postbatch_skip" };

/**
 * A book, a pool and a clock, emitting observations as they move.
 *
 * Every method appends to {@link observations}, which is the recorder's input
 * and the fixture's on-disk form.
 */
export class Simulation {
  readonly observations: Observation[] = [];

  /**
   * What each settlement's leg was built against. The enclave run watches the
   * same two states off the chain; recording them is what lets the oracle
   * recompute a settlement without inverting it out of its own result.
   */
  readonly legInputs: { settlementId: string; mirror: Pool; pool: Pool }[] = [];

  private readonly params: BookParams;
  private readonly gas: GasModel;
  private readonly profile: Profile;
  private readonly slots: WindowSlots;
  private readonly assetA: string;
  private readonly assetB: string;

  /**
   * The CT-13 ledger, per asset. Kept because the invariant is the one thing
   * asserted after *every* scenario and the soak, so a run that cannot produce
   * the ledger cannot be asserted — and an invariant only ever checked against
   * an enclave is an invariant checked once a night.
   */
  private readonly ledgers = new Map<string, AssetLedger>();
  private readonly balances = new Map<string, bigint>();

  private pool: Pool;
  private mirror: Pool;
  private unix: number;
  private l1Block: number;
  private l2Block: number;
  private windowId = 0n;
  private nonces = new Map<string, bigint>();
  private open = new Map<string, PlacedOrder>();
  private counterfactualsEmitted = new Set<string>();
  /**
   * Settlement attempts per window. A window that was evicted and then rolled
   * back and then settled sent three transactions, and each is its own
   * settlement in the stream — one id for all three would collapse the very
   * outcomes the fixture exists to show.
   */
  private attempts = new Map<string, number>();

  constructor(options: SimulationOptions) {
    this.params = options.params;
    this.gas = options.gas;
    this.profile = options.profile;
    this.slots = options.windowSlots;
    this.pool = options.pool;
    this.mirror = options.pool;
    this.unix = options.startUnix;
    this.l1Block = options.startL1Block;
    this.l2Block = options.startL2Block;
    this.assetA = options.assetA ?? "0x0000000000000000000000000000000000000000";
    this.assetB = options.assetB ?? "0x00000000000000000000000000000000000000b2";

    this.observations.push({
      kind: "genesis",
      at: this.unix,
      profile: this.profile,
      l2Block: this.l2Block,
      windowId: "0",
      slots: this.slots,
      mirror: toPoolState(this.mirror),
      referencePriceX96: fromBig(spotPriceX96(this.mirror.sqrtPriceX96)),
      l1Block: this.l1Block,
    });
  }

  /** One asset's ledger, created empty on first use. */
  private ledger(asset: string): AssetLedger {
    const existing = this.ledgers.get(asset);
    if (existing !== undefined) return existing;
    const fresh: AssetLedger = {
      escrowed: 0n,
      feesAccrued: 0n,
      dustAccrued: 0n,
      credited: 0n,
      deposits: 0n,
      released: 0n,
      withdrawn: 0n,
    };
    this.ledgers.set(asset, fresh);
    return fresh;
  }

  private sellAssetOf(side: Side): string {
    return side === "SELL_A_FOR_B" ? this.assetA : this.assetB;
  }

  private buyAssetOf(side: Side): string {
    return side === "SELL_A_FOR_B" ? this.assetB : this.assetA;
  }

  /** The CT-13 ledgers as the assertions read them. */
  escrowLedgers(): { asset: string; ledger: AssetLedger }[] {
    return [...this.ledgers.entries()].map(([asset, ledger]) => ({ asset, ledger }));
  }

  /** Recipient balances, `asset|owner` keyed — L2 balances in the full form. */
  recipientBalances(): { asset: string; owner: string; amount: bigint }[] {
    return [...this.balances.entries()].map(([key, amount]) => {
      const [asset = "", owner = ""] = key.split("|");
      return { asset, owner, amount };
    });
  }

  /** The open orders, in id order — what the settler would see. */
  openOrders(): PlacedOrder[] {
    return [...this.open.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The book's mirror, for a harness that wants to assert against it. */
  currentMirror(): Pool {
    return this.mirror;
  }

  /** The live pool on L1. */
  currentPool(): Pool {
    return this.pool;
  }

  /** Advances one L2 block, and an L1 slot every sixth. */
  block(): void {
    this.l2Block += 1;
    this.unix += L2_BLOCK_SECONDS;
    this.observations.push({ kind: "l2_block", at: this.unix, l2Block: this.l2Block });
    if (this.l2Block % BLOCKS_PER_SLOT === 0) {
      this.l1Block += 1;
      this.observations.push({ kind: "l1_slot", at: this.unix, l1Block: this.l1Block });
    }
  }

  /** Advances `count` L2 blocks. */
  blocks(count: number): void {
    for (let i = 0; i < count; i += 1) this.block();
  }

  /** `place` (CT-7): the id is derived from the owner and its nonce. */
  place(owner: string, side: Side, sellAmount: bigint, minBuyAmount: bigint, expiresAfter = 2): PlacedOrder {
    const nonce = this.nonces.get(owner) ?? 0n;
    this.nonces.set(owner, nonce + 1n);
    const id = orderId(owner, nonce);
    const order: PlacedOrder = {
      id,
      owner,
      recipient: owner,
      side,
      sellAmount,
      minBuyAmount,
      expiresAfter,
      placedWindow: fromBig(this.windowId),
    };
    this.open.set(id, order);
    const sellLedger = this.ledger(this.sellAssetOf(side));
    sellLedger.deposits += sellAmount;
    sellLedger.escrowed += sellAmount;
    this.observations.push({
      kind: "order_placed",
      at: this.unix,
      l2Block: this.l2Block,
      id,
      owner,
      side,
      sellAmount: fromBig(sellAmount),
      minBuyAmount: fromBig(minBuyAmount),
      recipient: order.recipient,
      expiresAfter,
      windowId: order.placedWindow,
    });
    this.emitCounterfactual(order);
    return order;
  }

  /** `cancel` (CT-7): escrow released, at any time while open. */
  cancel(id: string): void {
    const order = this.open.get(id);
    if (order === undefined) throw new Error(`cancel: ${id} is not open`);
    this.open.delete(id);
    const ledger = this.ledger(this.sellAssetOf(order.side));
    ledger.escrowed -= order.sellAmount;
    ledger.released += order.sellAmount;
    this.observations.push({ kind: "order_cancelled", at: this.unix, l2Block: this.l2Block, id });
  }

  /** The `drift` op: someone moved `MockPool` on L1. */
  drift(pool: Pool): void {
    this.pool = pool;
  }

  /**
   * The Sync block: the settler selects, submits, and the window ends the way
   * `outcome` says. Returns the settlement's id, or null when nothing was
   * settleable and no transaction was sent.
   */
  settle(outcome: WindowOutcome = { kind: "settled" }): Hash32 | null {
    const candidates = this.openOrders();
    const { selected } = selectFillable(candidates, this.params, this.mirror, this.pool);
    if (selected.length === 0) return null;

    const windowId = fromBig(this.windowId);
    const attempt = (this.attempts.get(windowId) ?? 0) + 1;
    this.attempts.set(windowId, attempt);
    const txHash = this.hash(`settle:${windowId}:${attempt}`);
    this.observations.push({
      kind: "selection",
      at: this.unix,
      l2Block: this.l2Block,
      windowId,
      orderIds: selected.map((order) => order.id),
    });

    let settlement;
    try {
      settlement = expectSettlement(selected, this.params, this.mirror, this.pool);
    } catch (error) {
      if (!(error instanceof SettlementRevert)) throw error;
      // Nothing settleable: the composed transaction would revert, which is a
      // poison eviction whatever the caller asked for.
      this.observations.push({
        kind: "settlement_evicted",
        at: this.unix,
        l2Block: this.l2Block,
        windowId,
        txHash: null,
        reason: error.reason,
      });
      return null;
    }

    this.legInputs.push({ settlementId: txHash, mirror: this.mirror, pool: this.pool });
    this.observations.push({
      kind: "settlement_submitted",
      at: this.unix,
      l2Block: this.l2Block,
      txHash,
      windowId,
      leg: {
        windowId,
        residualSide: settlement.leg.residualSide,
        residualIn: fromBig(settlement.leg.residualIn),
        minPriceX96: fromBig(settlement.leg.minPriceX96),
        maxPriceX96: fromBig(settlement.leg.maxPriceX96),
        deadline: this.unix + 24,
      },
    });

    if (outcome.kind === "evicted") {
      this.observations.push({
        kind: "settlement_evicted",
        at: this.unix,
        l2Block: this.l2Block,
        windowId,
        txHash,
        reason: outcome.reason,
      });
      this.block();
      return txHash;
    }

    // A rollback un-happens the L2 blocks, so the ledger has to be able to go
    // back with them: everything below is applied to a copy-on-write snapshot.
    const ledgersBefore = new Map(
      [...this.ledgers.entries()].map(([asset, ledger]) => [asset, { ...ledger }] as const),
    );
    const balancesBefore = new Map(this.balances);

    // The leg: the residual left the book for L1 and the bought asset arrived
    // inside the same frame (CT-11).
    const residualAsset = this.sellAssetOf(settlement.leg.residualSide);
    const boughtAsset = this.buyAssetOf(settlement.leg.residualSide);
    this.ledger(residualAsset).released += settlement.leg.residualIn;
    this.ledger(boughtAsset).deposits += settlement.result.amountOut;
    this.ledger(boughtAsset).dustAccrued += settlement.dustResidualSide;
    this.ledger(residualAsset).dustAccrued += settlement.dustCrossedSide;

    for (const fill of settlement.fills) {
      const order = candidates.find((entry) => entry.id === fill.id);
      if (order !== undefined) {
        const sell = this.ledger(this.sellAssetOf(order.side));
        sell.escrowed -= order.sellAmount;
        sell.feesAccrued += fill.feeAmount + fill.routeFeeAmount;
        const buyAsset = this.buyAssetOf(order.side);
        this.ledger(buyAsset).credited += fill.amountOut;
        const key = `${buyAsset}|${order.recipient}`;
        this.balances.set(key, (this.balances.get(key) ?? 0n) + fill.amountOut);
      }
      this.observations.push({
        kind: "order_filled",
        at: this.unix,
        l2Block: this.l2Block,
        txHash,
        id: fill.id,
        amountOut: fromBig(fill.amountOut),
        feeAmount: fromBig(fill.feeAmount),
        routeFeeAmount: fromBig(fill.routeFeeAmount),
        impactAmount: fromBig(fill.impactAmount),
      });
    }

    const mirrorBefore = this.mirror;
    this.pool = settlement.result.post;
    this.mirror = settlement.result.post;
    this.l1Block += 1;

    this.observations.push({
      kind: "window_settled",
      at: this.unix,
      l2Block: this.l2Block,
      txHash,
      windowId,
      result: {
        amountIn: fromBig(settlement.result.amountIn),
        amountOut: fromBig(settlement.result.amountOut),
        referencePriceX96: fromBig(settlement.result.referencePriceX96),
        executionPriceX96: fromBig(settlement.result.executionPriceX96),
        post: toPoolState(settlement.result.post),
        l1Block: this.l1Block,
      },
    });

    for (const fill of settlement.fills) this.open.delete(fill.id);
    this.windowId += 1n;

    const gasUsed = this.gas.base + this.gas.perFill * BigInt(settlement.fills.length);
    this.observations.push({
      kind: "l1_receipt",
      at: this.unix,
      txHash,
      receipt: {
        txHash: this.hash(`l1:${windowId}:${attempt}`),
        blockNumber: this.l1Block,
        gasUsed: fromBig(gasUsed),
        effectiveGasPriceWei: fromBig(this.gas.priceWei),
        gasCostWei: fromBig(gasUsed * this.gas.priceWei),
        status: "success",
      },
    });

    if (outcome.kind === "rolled_back") {
      this.block();
      // The L2 blocks un-happen: the fills are undone, the mirror goes back,
      // and the window re-forms. `postbatch_skip` is the one cause that spent
      // L1 gas (SV-4) — the batch landed without the entry.
      this.observations.push({
        kind: "settlement_rolled_back",
        at: this.unix,
        l2Block: this.l2Block,
        windowId,
        txHash,
        cause: outcome.cause,
        l1GasSpent: outcome.cause === "postbatch_skip",
      });
      this.windowId -= 1n;
      for (const fill of settlement.fills) {
        const placed = candidates.find((entry) => entry.id === fill.id);
        if (placed !== undefined) this.open.set(placed.id, placed);
      }
      // The mirror and the ledger un-happen with it (SV-4, CT-13): an escrow
      // invariant that survived a rollback only because the harness forgot to
      // undo the fills would be no invariant at all.
      this.mirror = mirrorBefore;
      this.ledgers.clear();
      for (const [asset, ledger] of ledgersBefore) this.ledgers.set(asset, ledger);
      this.balances.clear();
      for (const [key, amount] of balancesBefore) this.balances.set(key, amount);
      return txHash;
    }

    this.sweepExpired();
    this.block();
    return txHash;
  }

  /**
   * `_sweepExpired`: an order lives `expiresAfter` windows past the one it was
   * placed in, and the settlement that carries the window past that releases
   * its escrow. Without this the soak could never satisfy HX-4's "every order
   * reaches a terminal state" — a quiet order would sit open for ever.
   */
  private sweepExpired(): void {
    for (const order of this.openOrders()) {
      if (this.windowId <= BigInt(order.placedWindow) + BigInt(order.expiresAfter)) continue;
      this.open.delete(order.id);
      const asset = this.sellAssetOf(order.side);
      this.ledger(asset).escrowed -= order.sellAmount;
      this.ledger(asset).credited += order.sellAmount;
      const key = `${asset}|${order.owner}`;
      this.balances.set(key, (this.balances.get(key) ?? 0n) + order.sellAmount);
      this.observations.push({
        kind: "order_expired",
        at: this.unix,
        l2Block: this.l2Block,
        id: order.id,
      });
    }
  }

  /**
   * IX-3's counterfactual: what this owner's own address last paid for a swap
   * on L1. Emitted once per order, because that is the granularity the
   * amortisation stream keeps it at.
   */
  private emitCounterfactual(order: PlacedOrder): void {
    if (this.counterfactualsEmitted.has(order.id)) return;
    this.counterfactualsEmitted.add(order.id);
    this.observations.push({
      kind: "counterfactual",
      at: this.unix,
      orderId: order.id,
      gasUsed: fromBig(this.gas.directSwap),
      gasCostWei: fromBig(this.gas.directSwap * this.gas.priceWei),
      source: "user_last_l1_swap",
    });
  }

  private hash(label: string): Hash32 {
    return keccak256Utf8(`eez-dex/scenario/${label}`);
  }
}

/**
 * The readings the assertions want, taken off a simulation instead of an
 * enclave — the hermetic half of A.6.
 *
 * The enclave run reads exactly these fields off the chain with `cast`. Both
 * paths feed the same {@link ../lib/assert.ts} checks, which is what makes the
 * offline suite a rehearsal of the nightly one rather than a separate,
 * weaker set of assertions.
 */
export function readingsFrom(
  simulation: Simulation,
  params: BookParams,
  expect: { mode: "happy" | "matrix" | "soak"; fillsPerSettlement?: number; settlements?: number; allOrdersTerminal?: boolean },
  legInputs: readonly { settlementId: string; mirror: Pool; pool: Pool }[],
): Record<string, unknown> {
  return {
    profile: "full",
    params: {
      feeMode: params.feeMode,
      feeBps: fromBig(params.feeBps),
      feeFixedA: fromBig(params.feeFixedA),
      feeFixedB: fromBig(params.feeFixedB),
      routeFeeModel: params.routeFeeModel,
      routeFeeWei: fromBig(params.routeFeeWei),
      assetAIsNative: params.assetAIsNative ? "true" : "false",
    },
    poolFee: fromBig(simulation.currentPool().fee),
    mirror: toPoolState(simulation.currentMirror()),
    poolL1: toPoolState(simulation.currentPool()),
    escrow: simulation.escrowLedgers().map(({ asset, ledger }) => ({
      asset,
      escrowed: fromBig(ledger.escrowed),
      feesAccrued: fromBig(ledger.feesAccrued),
      dustAccrued: fromBig(ledger.dustAccrued),
      credited: fromBig(ledger.credited),
      deposits: fromBig(ledger.deposits),
      released: fromBig(ledger.released),
      withdrawn: fromBig(ledger.withdrawn),
      drift: fromBig(
        ledger.escrowed +
          ledger.feesAccrued +
          ledger.dustAccrued +
          ledger.credited -
          (ledger.deposits - ledger.released - ledger.withdrawn),
      ),
    })),
    balances: simulation.recipientBalances().map((balance) => ({
      asset: balance.asset,
      owner: balance.owner,
      amount: fromBig(balance.amount),
    })),
    openOrders: simulation.openOrders().map((order) => ({
      id: order.id,
      side: order.side,
      sellAmount: fromBig(order.sellAmount),
      minBuyAmount: fromBig(order.minBuyAmount),
    })),
    legInputs: legInputs.map((entry) => ({
      settlementId: entry.settlementId,
      mirror: toPoolState(entry.mirror),
      pool: toPoolState(entry.pool),
    })),
    expect,
  };
}
