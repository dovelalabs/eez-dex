/**
 * Watching a run — RD-2 HX-2, HX-5.
 *
 * A live observer, not a post-hoc sweep. Two of the things A.6 asks about are
 * not recoverable after the fact: the states the leg was built against (the
 * mirror in the block before the Sync block, and `MockPool` at the L1 head the
 * leg read), and the absence of an L1 transaction that makes poison eviction
 * free. So the harness watches, every L2 block, and writes what it saw.
 *
 * What is *observed* and what is *derived* is stated field by field below,
 * because an assertion built on a derived number is only as good as the
 * derivation:
 *
 * | Field | Where it comes from |
 * |---|---|
 * | orders, fills, deductions | `WindowBook` logs, decoded |
 * | `WindowResult` | the `WindowSettled` log |
 * | the leg's `residualIn` | `result.amountIn`, which CT-9 makes the same number |
 * | the leg's `deadline` | `settleWindow`'s calldata |
 * | the settler's selection | the same calldata — a suggestion, not the fills (FL-8) |
 * | the leg's `residualSide` | the side whose fills carry impact; only the residual side pays it (CT-12) |
 * | the leg's price band | recomputed from the filled orders — the contract does not emit it |
 * | the L1 receipt | the batch transaction in `result.l1Block` |
 * | evictions and rollbacks | marks the harness wrote when it induced them, each carrying the evidence |
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { PoolState, RollbackCause, Side } from "../../indexer/schema/index.ts";
import { chargeFees, priceBand } from "./book.ts";
import type { BookOrder, BookParams } from "./book.ts";
import { Chain, decodeSettleWindow, readBalance, readBookLogs, readEscrowLedger, readMirror, readOpenOrders, readPool } from "./chain.ts";
import type { BookLog } from "./chain.ts";
import { httpTransport } from "./chain.ts";
import { fromBig, spotPriceX96, toBig } from "./math.ts";
import { formatObservationLog } from "./observation.ts";
import type { Observation, Profile } from "./observation.ts";

/** L2 blocks in one L1 slot. */
const BLOCKS_PER_SLOT = 6;

/** A failure the harness induced, with the evidence that it happened. */
export interface Mark {
  readonly kind: "evicted" | "rolled_back";
  readonly windowId: string;
  readonly atL2Block: number;
  readonly txHash?: string;
  /** Eviction: why the composed transaction would have reverted. */
  readonly reason?: string;
  /** Rollback: which of SV-4's three paths, and so whether gas was spent. */
  readonly cause?: RollbackCause;
  readonly l1GasSpent?: boolean;
}

/** Where the observer points and what it is watching. */
export interface ObserveConfig {
  readonly l1Rpc: string;
  readonly l2Rpc: string;
  readonly profile: Profile;
  readonly windowBook: string;
  readonly pool: string;
  readonly assetA: string;
  readonly assetB: string;
  readonly rollupManager: string;
  readonly traders: readonly string[];
  readonly windowSlots: 1 | 2;
  readonly params: BookParams;
  readonly poolFee: string;
  /** Where the harness appends its marks, one JSON object per line. */
  readonly marksFile?: string;
  /** IX-3's per-order counterfactual, measured by the harness on L1. */
  readonly counterfactualGasUsed?: string;
  readonly counterfactualGasCostWei?: string;
}

/** The observer's output. */
export interface Observed {
  readonly observations: Observation[];
  readonly legInputs: { settlementId: string; mirror: PoolState; pool: PoolState }[];
}

/** One L2 block's worth of state, kept so the Sync block can look backwards. */
interface Snapshot {
  readonly mirror: PoolState;
  readonly pool: PoolState;
}

/**
 * Watches both chains and writes observations as they happen.
 *
 * `step()` is one poll; the CLI loops it. Splitting it that way keeps the loop
 * out of the logic and lets a test drive the observer block by block over a
 * stubbed transport.
 */
export class Observer {
  private readonly config: ObserveConfig;
  private readonly l1: Chain;
  private readonly l2: Chain;

  readonly observations: Observation[] = [];
  readonly legInputs: { settlementId: string; mirror: PoolState; pool: PoolState }[] = [];

  private nextBlock = 0;
  private lastSlotBlock = 0;
  private l1Block = 0;
  private previous: Snapshot | null = null;
  private started = false;
  private marksSeen = 0;
  private readonly orders = new Map<string, BookOrder & { placed: BookLog }>();
  private readonly pendingReceipts: { settlementId: string; l1Block: number }[] = [];

  constructor(config: ObserveConfig, l1: Chain, l2: Chain) {
    this.config = config;
    this.l1 = l1;
    this.l2 = l2;
  }

  /** Records the book as deployed: the first window and its genesis mirror. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const head = await this.l2.blockNumber();
    const at = await this.l2.blockTimestamp(head);
    const mirror = await readMirror(this.l2, this.config.windowBook);
    const windowId = fromBig(await this.l2.callWord(this.config.windowBook, "windowId()"));
    this.l1Block = await this.l1.blockNumber();

    this.observations.push({
      kind: "genesis",
      at,
      profile: this.config.profile,
      l2Block: head,
      windowId,
      slots: this.config.windowSlots,
      mirror,
      referencePriceX96: fromBig(spotPriceX96(toBig(mirror.sqrtPriceX96))),
      l1Block: this.l1Block,
    });

    this.nextBlock = head + 1;
    this.lastSlotBlock = head;
    this.previous = { mirror, pool: await readPool(this.l1, this.config.pool) };
  }

  /** One poll: every L2 block since the last one, in order. */
  async step(): Promise<void> {
    if (!this.started) await this.start();
    const head = await this.l2.blockNumber();
    for (let block = this.nextBlock; block <= head; block += 1) await this.block(block);
    this.nextBlock = Math.max(this.nextBlock, head + 1);
    await this.drainReceipts();
    this.readMarks();
  }

  private async block(block: number): Promise<void> {
    const at = await this.l2.blockTimestamp(block);
    this.observations.push({ kind: "l2_block", at, l2Block: block });

    // The L1 head is not visible from L2, so the slot clock is read from L1
    // directly — and only every sixth L2 block, which is the cadence the
    // theater's progress bar runs on.
    if (block - this.lastSlotBlock >= BLOCKS_PER_SLOT) {
      this.lastSlotBlock = block;
      this.l1Block = await this.l1.blockNumber();
      this.observations.push({ kind: "l1_slot", at, l1Block: this.l1Block });
    }

    const logs = await readBookLogs(this.l2, this.config.windowBook, block, block);
    const settled = logs.find((log) => log.kind === "WindowSettled");
    if (settled !== undefined) await this.syncBlock(block, at, logs, settled);
    else for (const log of logs) this.plainLog(at, block, log);

    this.previous = {
      mirror: await readMirror(this.l2, this.config.windowBook),
      pool: await readPool(this.l1, this.config.pool),
    };
  }

  /** Placements, cancels and expiries: everything outside a Sync block. */
  private plainLog(at: number, block: number, log: BookLog): void {
    switch (log.kind) {
      case "OrderPlaced":
        this.orders.set(log.id, {
          id: log.id,
          side: log.side,
          sellAmount: toBig(log.sellAmount),
          minBuyAmount: toBig(log.minBuyAmount),
          placed: log,
        });
        this.observations.push({
          kind: "order_placed",
          at,
          l2Block: block,
          id: log.id,
          owner: log.owner,
          side: log.side,
          sellAmount: log.sellAmount,
          minBuyAmount: log.minBuyAmount,
          recipient: log.recipient,
          expiresAfter: log.expiresAfter,
          windowId: log.windowId,
        });
        if (this.config.counterfactualGasUsed !== undefined) {
          this.observations.push({
            kind: "counterfactual",
            at,
            orderId: log.id,
            gasUsed: this.config.counterfactualGasUsed,
            gasCostWei: this.config.counterfactualGasCostWei ?? "0",
            source: "user_last_l1_swap",
          });
        }
        break;
      case "OrderCancelled":
        this.observations.push({ kind: "order_cancelled", at, l2Block: block, id: log.id });
        break;
      case "OrderExpired":
        this.observations.push({ kind: "order_expired", at, l2Block: block, id: log.id });
        break;
      default:
        break;
    }
  }

  /**
   * The Sync block. The order matters and is the chain's own: the settler's
   * suggestion, the leg it implied, every fill, then the settlement.
   */
  private async syncBlock(block: number, at: number, logs: readonly BookLog[], settled: BookLog): Promise<void> {
    if (settled.kind !== "WindowSettled") return;

    // Anything else in this block that was not part of the settlement — a
    // cancel racing it, an expiry swept by it — is still a fact of the block.
    for (const log of logs) {
      if (log.kind === "OrderPlaced" || log.kind === "OrderCancelled" || log.kind === "OrderExpired") {
        this.plainLog(at, block, log);
      }
    }

    const fills = logs.filter((log) => log.kind === "OrderFilled");
    const input = await this.l2.transactionInput(settled.txHash);
    const { orderIds, deadline } = decodeSettleWindow(input);

    this.observations.push({
      kind: "selection",
      at,
      l2Block: block,
      windowId: settled.windowId,
      orderIds,
    });

    // Only the residual side pays impact (CT-12), so a non-zero `impactAmount`
    // names the side the leg swapped. A window that crossed exactly has no
    // impact to read, and no residual either.
    const impacted = fills.find((log) => log.kind === "OrderFilled" && toBig(log.impactAmount) > 0n);
    const filledOrders: BookOrder[] = [];
    for (const log of fills) {
      if (log.kind !== "OrderFilled") continue;
      const order = this.orders.get(log.id);
      if (order !== undefined) filledOrders.push(order);
    }
    const residualSide: Side =
      impacted !== undefined && impacted.kind === "OrderFilled"
        ? this.orders.get(impacted.id)?.side ?? "SELL_A_FOR_B"
        : (filledOrders[0]?.side ?? "SELL_A_FOR_B");

    // The block before the Sync block: the mirror the leg was built against
    // and the pool the leg read. The observer has snapshotted both every block
    // since it started, so a missing one means it was started late — which is
    // a harness fault worth stopping for, not a number to invent.
    const previous = this.previous;
    if (previous === null) {
      throw new Error(`the observer has no snapshot before the Sync block at L2 ${block}`);
    }
    const mirrorBefore = previous.mirror;
    const band = priceBand(
      chargeFees(filledOrders, this.config.params, spotPriceX96(toBig(mirrorBefore.sqrtPriceX96))).orders,
    );

    this.observations.push({
      kind: "settlement_submitted",
      at,
      l2Block: block,
      txHash: settled.txHash,
      windowId: settled.windowId,
      leg: {
        windowId: settled.windowId,
        residualSide,
        residualIn: fromBig(settled.result.amountIn),
        minPriceX96: fromBig(band.minPriceX96),
        maxPriceX96: fromBig(band.maxPriceX96),
        deadline,
      },
    });
    this.legInputs.push({ settlementId: settled.txHash, mirror: mirrorBefore, pool: previous.pool });

    for (const log of fills) {
      if (log.kind !== "OrderFilled") continue;
      this.observations.push({
        kind: "order_filled",
        at,
        l2Block: block,
        txHash: settled.txHash,
        id: log.id,
        amountOut: log.amountOut,
        feeAmount: log.feeAmount,
        routeFeeAmount: log.routeFeeAmount,
        impactAmount: log.impactAmount,
      });
    }

    this.observations.push({
      kind: "window_settled",
      at,
      l2Block: block,
      txHash: settled.txHash,
      windowId: settled.windowId,
      result: {
        amountIn: fromBig(settled.result.amountIn),
        amountOut: fromBig(settled.result.amountOut),
        referencePriceX96: fromBig(settled.result.referencePriceX96),
        executionPriceX96: fromBig(settled.result.executionPriceX96),
        post: {
          sqrtPriceX96: fromBig(settled.result.post.sqrtPriceX96),
          liquidity: fromBig(settled.result.post.liquidity),
          tick: settled.result.post.tick,
        },
        l1Block: settled.result.l1Block,
      },
    });

    this.pendingReceipts.push({ settlementId: settled.txHash, l1Block: settled.result.l1Block });
  }

  /**
   * The L1 leg's cost. The leg rode inside the batch the poster sent in
   * `result.l1Block`, so that block's transaction to the rollup manager is the
   * receipt — and the gas on it is what EC-1's fee ceiling is derived from.
   */
  private async drainReceipts(): Promise<void> {
    const pending = this.pendingReceipts.splice(0, this.pendingReceipts.length);
    for (const entry of pending) {
      const hashes = await this.l1.blockTransactions(entry.l1Block);
      let found = false;
      for (const hash of hashes) {
        const receipt = await this.l1.receipt(hash);
        if (receipt === null) continue;
        const transaction = await this.l1.transaction(hash);
        const to = transaction?.to ?? "";
        if (to.toLowerCase() !== this.config.rollupManager.toLowerCase()) continue;
        this.observations.push({
          kind: "l1_receipt",
          at: await this.l1.blockTimestamp(entry.l1Block),
          txHash: entry.settlementId,
          receipt: {
            txHash: hash,
            blockNumber: receipt.blockNumber,
            gasUsed: fromBig(receipt.gasUsed),
            effectiveGasPriceWei: fromBig(receipt.effectiveGasPrice),
            gasCostWei: fromBig(receipt.gasUsed * receipt.effectiveGasPrice),
            status: receipt.status,
          },
        });
        found = true;
        break;
      }
      // A settlement whose batch transaction cannot be found is not quietly
      // dropped: without the receipt the amortisation is null, and IX-3 says a
      // missing denominator is reported, never invented.
      if (!found) this.pendingReceipts.push(entry);
    }
  }

  /** Marks the harness wrote when it induced a failure. */
  private readMarks(): void {
    const file = this.config.marksFile;
    if (file === undefined || !existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    for (const line of lines.slice(this.marksSeen)) {
      const mark = JSON.parse(line) as Mark;
      const at = this.observations[this.observations.length - 1]?.at ?? 0;
      if (mark.kind === "evicted") {
        this.observations.push({
          kind: "settlement_evicted",
          at,
          l2Block: mark.atL2Block,
          windowId: mark.windowId,
          txHash: mark.txHash ?? null,
          reason: mark.reason ?? "unknown",
        });
      } else {
        this.observations.push({
          kind: "settlement_rolled_back",
          at,
          l2Block: mark.atL2Block,
          windowId: mark.windowId,
          txHash: mark.txHash ?? "",
          cause: mark.cause ?? "bundle_missed",
          l1GasSpent: mark.l1GasSpent ?? false,
        });
      }
    }
    this.marksSeen = lines.length;
  }

  /** Everything the assertions read off the chain at the end of a run. */
  async readings(expect: Record<string, unknown>): Promise<Record<string, unknown>> {
    const book = this.config.windowBook;
    const assets = [this.config.assetA, this.config.assetB];
    const balances: { asset: string; owner: string; amount: string }[] = [];
    for (const asset of assets) {
      for (const trader of this.config.traders) {
        balances.push({ asset, owner: trader, amount: await readBalance(this.l2, book, asset, trader) });
      }
    }
    const escrow = [];
    for (const asset of assets) escrow.push(await readEscrowLedger(this.l2, book, asset));

    return {
      profile: this.config.profile,
      params: {
        feeMode: this.config.params.feeMode,
        feeBps: fromBig(this.config.params.feeBps),
        feeFixedA: fromBig(this.config.params.feeFixedA),
        feeFixedB: fromBig(this.config.params.feeFixedB),
        routeFeeModel: this.config.params.routeFeeModel,
        routeFeeWei: fromBig(this.config.params.routeFeeWei),
        assetAIsNative: this.config.params.assetAIsNative ? "true" : "false",
      },
      poolFee: this.config.poolFee,
      mirror: await readMirror(this.l2, book),
      poolL1: await readPool(this.l1, this.config.pool),
      escrow,
      balances,
      openOrders: await readOpenOrders(this.l2, book),
      legInputs: this.legInputs,
      expect,
    };
  }
}

/** Builds an observer over HTTP, for the enclave run. */
export function observerFor(config: ObserveConfig): Observer {
  return new Observer(config, new Chain(httpTransport(config.l1Rpc)), new Chain(httpTransport(config.l2Rpc)));
}

/** Writes what an observer saw, in the two files the rest of the run reads. */
export function writeObserved(directory: string, observer: Observer, expect: Record<string, unknown>): Promise<void> {
  writeFileSync(`${directory}/observations.jsonl`, formatObservationLog(observer.observations));
  return observer.readings(expect).then((readings) => {
    writeFileSync(`${directory}/readings.json`, `${JSON.stringify(readings, null, 2)}\n`);
  });
}

/** Appends a mark, for a harness inducing a failure from the shell. */
export function appendMark(file: string, mark: Mark): void {
  appendFileSync(file, `${JSON.stringify(mark)}\n`);
}
