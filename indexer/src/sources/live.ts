/**
 * The live source — RD-2 IX-1.
 *
 * The IO half of the live path: it reads the three upstream views once a tick,
 * hands them to the pure fold, and pushes what came out at the hub. Nothing
 * here decides anything — that is `fold.ts` — and nothing here writes: every
 * call below is an `eth_` read or a GET, there is no signer in this package,
 * and the only address it knows is the book's.
 *
 * Every read is individually fallible and individually reported. An L1 that
 * stops answering does not stop the L2 stream; it becomes a source in state
 * `unavailable` with the reason attached, which is the frontend's cue to say
 * so rather than to keep animating (§7 preamble, FE-12).
 */

import type { Sink } from "../hub.ts";
import { readBookLogs, readBookView, readOrder, type BookLog, type BookOrder, type BookView } from "../chain/book.ts";
import { EMPTY_GAS_SAMPLE, readGasSample, readReceipt, type GasSample, type Receipt } from "../chain/l1.ts";
import { getBlock, type JsonRpc } from "../chain/rpc.ts";
import { readSettlerView, type SettlerView } from "../settler.ts";
import type { SourceHealth } from "../protocol.ts";
import { foldSample, initialModel, type ChainSample, type L2Head, type LiveModel } from "./fold.ts";

/** Where the live source points and how far it looks. */
export interface LiveSourceOptions {
  readonly l2: JsonRpc;
  readonly windowBook: string;
  /** Null where no L1 endpoint is configured: a legitimate read-only setup. */
  readonly l1: JsonRpc | null;
  /** The settler's projection, served over HTTP. Null where it is not run. */
  readonly settlerUrl: string | null;
  /** The L2 block to start scanning logs from. Defaults to `head - history`. */
  readonly fromBlock?: number;
  /** How far back to look on a cold start. */
  readonly historyBlocks?: number;
  /** The widest `eth_getLogs` range to ask for in one tick. */
  readonly logRange?: number;
  /** How many L1 blocks IX-3's swap-gas sample covers. */
  readonly gasSampleBlocks?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

const DEFAULTS = {
  historyBlocks: 2_000,
  logRange: 5_000,
  gasSampleBlocks: 50,
} as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the three upstream views and pushes one tick's events. */
export class LiveSource {
  #model: LiveModel = initialModel();
  #scanned: number | null = null;
  #gasSample: GasSample = EMPTY_GAS_SAMPLE;
  #blockTimes = new Map<number, number>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  readonly #options: LiveSourceOptions;
  readonly #sink: Sink;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;

  constructor(options: LiveSourceOptions, sink: Sink) {
    this.#options = options;
    this.#sink = sink;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** The fold's state, for tests and for `Indexer.snapshot()`'s callers. */
  get model(): LiveModel {
    return this.#model;
  }

  /** Reads every upstream once and emits what changed. */
  async tick(): Promise<void> {
    const sample = await this.#sample();
    const { model, events } = foldSample(this.#model, sample);
    this.#model = model;
    for (const event of events) this.#sink.emit(event);
  }

  /** Ticks every `intervalMs`, never re-entering a tick that is still running. */
  start(intervalMs: number): void {
    if (this.#timer !== null) return;
    const run = () => {
      if (this.#ticking) return;
      this.#ticking = true;
      void this.tick()
        .catch((error: unknown) => {
          this.#sink.health({
            source: "l2",
            state: "unavailable",
            detail: reason(error),
            observedAtUnix: this.#now(),
          });
        })
        .finally(() => {
          this.#ticking = false;
        });
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref?.();
  }

  /** Stops ticking. The gateway keeps serving what it already has. */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #sample(): Promise<ChainSample> {
    const atUnix = this.#now();
    const { l2, book, logs, blockTimes, resolved } = await this.#readL2(atUnix);
    const { l1, receipts, gasSample } = await this.#readL1(atUnix);
    const settler = await this.#readSettler(atUnix);

    return { atUnix, l2, book, logs, blockTimes, resolved, l1, settler, receipts, gasSample };
  }

  async #readL2(atUnix: number): Promise<{
    l2: L2Head | null;
    book: BookView | null;
    logs: readonly BookLog[];
    blockTimes: ReadonlyMap<number, number>;
    resolved: ReadonlyMap<string, BookOrder>;
  }> {
    const { l2, windowBook } = this.#options;
    try {
      const [latest, safe] = await Promise.all([getBlock(l2, "latest"), this.#safeHead()]);
      if (latest === null) throw new Error("the L2 has no latest block");
      const head: L2Head = { head: latest.number, safeHead: safe ?? latest.number, timestamp: latest.timestamp };

      const book = await readBookView(l2, windowBook);
      const logs = await this.#readLogs(head);
      const blockTimes = await this.#readBlockTimes(logs);
      const resolved = await this.#resolveOrders(book);

      this.#health("l2", "ok", null, atUnix);
      return { l2: head, book, logs, blockTimes, resolved };
    } catch (error) {
      this.#health("l2", "unavailable", reason(error), atUnix);
      return { l2: null, book: null, logs: [], blockTimes: new Map(), resolved: new Map() };
    }
  }

  /**
   * The safe head, where the escrow invariant holds (CT-13).
   *
   * A chain that does not serve the tag is not an error: the gateway falls
   * back to the latest block and says nothing, because the fallback changes
   * nothing a reader can observe.
   */
  async #safeHead(): Promise<number | null> {
    try {
      const block = await getBlock(this.#options.l2, "safe");
      return block?.number ?? null;
    } catch {
      return null;
    }
  }

  async #readLogs(head: L2Head): Promise<readonly BookLog[]> {
    const history = this.#options.historyBlocks ?? DEFAULTS.historyBlocks;
    const range = this.#options.logRange ?? DEFAULTS.logRange;
    const to = head.safeHead;
    if (this.#scanned === null) {
      this.#scanned = this.#options.fromBlock ?? Math.max(0, to - history);
    }
    if (this.#scanned > to) return [];

    const from = this.#scanned;
    const until = Math.min(to, from + range - 1);
    const logs = await readBookLogs(this.#options.l2, this.#options.windowBook, from, until);
    this.#scanned = until + 1;
    return logs;
  }

  /** The timestamps of the blocks that carried logs — never an estimate. */
  async #readBlockTimes(logs: readonly BookLog[]): Promise<ReadonlyMap<number, number>> {
    const wanted = new Set(logs.map((log) => log.at.blockNumber));
    for (const block of [...wanted]) {
      if (this.#blockTimes.has(block)) wanted.delete(block);
    }

    for (const block of wanted) {
      const header = await getBlock(this.#options.l2, `0x${block.toString(16)}`);
      if (header !== null) this.#blockTimes.set(block, header.timestamp);
    }
    return this.#blockTimes;
  }

  /** Orders open on-chain that this gateway was not running to see placed. */
  async #resolveOrders(book: BookView): Promise<ReadonlyMap<string, BookOrder>> {
    const resolved = new Map<string, BookOrder>();
    for (const id of book.openOrderIds) {
      if (this.#model.orders.has(id)) continue;
      resolved.set(id, await readOrder(this.#options.l2, this.#options.windowBook, id));
    }
    return resolved;
  }

  async #readL1(atUnix: number): Promise<{
    l1: { head: number; timestamp: number } | null;
    receipts: ReadonlyMap<string, Receipt>;
    gasSample: GasSample;
  }> {
    const l1 = this.#options.l1;
    if (l1 === null) {
      this.#health("l1", "absent", "no L1 endpoint configured: L1 receipts and IX-3 are not available", atUnix);
      return { l1: null, receipts: new Map(), gasSample: this.#gasSample };
    }

    try {
      const head = await getBlock(l1, "latest");
      if (head === null) throw new Error("the L1 has no latest block");

      const receipts = new Map<string, Receipt>();
      for (const [settlementId, txHash] of this.#model.l1TxHashes) {
        const settlement = this.#model.settlements.get(settlementId);
        if (settlement !== undefined && settlement.l1Receipt !== null && settlement.amortisation !== null) continue;
        const receipt = await readReceipt(l1, txHash);
        if (receipt !== null) receipts.set(txHash, receipt);
      }

      // IX-3's sample is refreshed once per window of blocks, not per tick: it
      // is what a retail swap costs, and that does not move block to block.
      const span = this.#options.gasSampleBlocks ?? DEFAULTS.gasSampleBlocks;
      if (head.number - this.#gasSample.toBlock >= span) {
        this.#gasSample = await readGasSample(l1, head.number, span, this.#gasSample);
      }

      const detail =
        this.#gasSample.medianSwapGas === null
          ? "no swap observed in the sampled window yet: the IX-3 counterfactual is not available"
          : null;
      this.#health("l1", detail === null ? "ok" : "degraded", detail, atUnix);
      return { l1: { head: head.number, timestamp: head.timestamp }, receipts, gasSample: this.#gasSample };
    } catch (error) {
      this.#health("l1", "unavailable", reason(error), atUnix);
      return { l1: null, receipts: new Map(), gasSample: this.#gasSample };
    }
  }

  async #readSettler(atUnix: number): Promise<SettlerView | null> {
    const url = this.#options.settlerUrl;
    if (url === null) {
      this.#health(
        "settler",
        "absent",
        "no settler configured: the price band, evictions and rollbacks are not observable from L2 logs alone",
        atUnix,
      );
      return null;
    }
    try {
      const view = await readSettlerView(url, this.#fetch);
      this.#health("settler", "ok", null, atUnix);
      return view;
    } catch (error) {
      this.#health("settler", "unavailable", reason(error), atUnix);
      return null;
    }
  }

  #health(source: SourceHealth["source"], state: SourceHealth["state"], detail: string | null, atUnix: number): void {
    this.#sink.health({ source, state, detail, observedAtUnix: atUnix });
  }
}
