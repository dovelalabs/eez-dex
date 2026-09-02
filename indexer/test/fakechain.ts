/**
 * A scripted chain, for driving the real live source — RD-2 TS-5.
 *
 * The "simulated live source" TS-5 asks for is not a stub of the gateway: it
 * is a stub of *Ethereum*. Everything above the JSON-RPC seam — the ABI
 * decoding, the log scan, the view reads, the fold, the hub — is the code that
 * runs in production, so a stream recorded here is a stream the gateway
 * really produces.
 *
 * The script below walks one book through the four window outcomes A.4 names:
 * settled with a fill on each side of the cross, one order rolled at the
 * boundary, one window poison-evicted, and one settled window rolled back.
 */

import type { JsonRpc } from "../src/chain/rpc.ts";
import { encodeCall } from "../src/chain/abi.ts";
import { TOPICS } from "../src/chain/book.ts";

export const BOOK = "0x00000000000000000000000000000000000000b0";
export const ROUTER = "0x00000000000000000000000000000000000000c0";

/** Q96, and a mirror at 2000 B per A. */
const Q96 = 1n << 96n;
export const PRICE_X96 = 2000n * Q96;
const SQRT_PRICE = 3_543_191_142_285_914_205_922_034_323_214n; // ~sqrt(2000) * 2^96

const word = (value: bigint | number | string): string => BigInt(value).toString(16).padStart(64, "0");
const address = (value: string): string => value.slice(2).toLowerCase().padStart(64, "0");
const hash = (value: string): string => value.slice(2).toLowerCase().padStart(64, "0");

/** Owners of the scripted orders — three accounts, as HX-2's happy path has. */
export const OWNERS = {
  alice: "0x00000000000000000000000000000000000000a1",
  bob: "0x00000000000000000000000000000000000000b2",
  carol: "0x00000000000000000000000000000000000000c3",
  dave: "0x00000000000000000000000000000000000000d4",
} as const;

export const ORDERS = {
  alice: `0x${"a1".repeat(32)}`,
  bob: `0x${"b2".repeat(32)}`,
  carol: `0x${"c3".repeat(32)}`,
  dave: `0x${"d4".repeat(32)}`,
  erin: `0x${"e5".repeat(32)}`,
} as const;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/** The book's views, as the fake chain holds them. */
interface BookState {
  windowId: bigint;
  slots: number;
  startBlock: number;
  blocksRemaining: number;
  mirrorSqrtPrice: bigint;
  mirrorLiquidity: bigint;
  mirrorTick: number;
  mirrorTimestamp: number;
  referencePriceX96: bigint;
  referenceL1Block: number;
  mirrorAgeSlots: number;
  openOrderIds: string[];
}

/** A minimal L2: `WindowBook`'s views and its logs. */
export class FakeL2 implements JsonRpc {
  readonly name = "l2";
  head = 1;
  timestamp = 1_800_000_000;
  logs: RawLog[] = [];
  book: BookState = {
    windowId: 1n,
    slots: 2,
    startBlock: 1,
    blocksRemaining: 5,
    mirrorSqrtPrice: SQRT_PRICE,
    mirrorLiquidity: 10n ** 24n,
    mirrorTick: 76_012,
    mirrorTimestamp: 1_799_999_988,
    referencePriceX96: PRICE_X96,
    referenceL1Block: 21_000_000,
    mirrorAgeSlots: 1,
    openOrderIds: [],
  };

  /** Advances the L2 head by `blocks`, two seconds each (RD-2 §1). */
  advance(blocks: number): void {
    this.head += blocks;
    this.timestamp += blocks * 2;
    this.book.blocksRemaining = Math.max(0, this.book.blocksRemaining - blocks);
  }

  place(id: string, owner: string, side: 0 | 1, sellAmount: bigint, minBuyAmount: bigint): void {
    this.#log(
      [TOPICS.orderPlaced, id, `0x${address(owner)}`, `0x${word(this.book.windowId)}`],
      `0x${word(side)}${word(sellAmount)}${word(minBuyAmount)}${address(owner)}${word(4)}`,
      `0x${"11".repeat(31)}01`,
    );
    this.book.openOrderIds.push(id);
  }

  cancel(id: string, owner: string, refund: bigint): void {
    this.#log([TOPICS.orderCancelled, id, `0x${address(owner)}`], `0x${word(refund)}`, `0x${"22".repeat(31)}02`);
    this.book.openOrderIds = this.book.openOrderIds.filter((open) => open !== id);
  }

  /** Fills and the settlement, in the order `_applyResult` emits them (CT-12). */
  settle(
    txHash: string,
    fills: readonly { id: string; amountOut: bigint; fee: bigint; routeFee: bigint; impact: bigint }[],
    result: { amountIn: bigint; amountOut: bigint; referencePriceX96: bigint; executionPriceX96: bigint },
  ): void {
    for (const fill of fills) {
      this.#log(
        [TOPICS.orderFilled, fill.id],
        `0x${word(fill.amountOut)}${word(fill.fee)}${word(fill.routeFee)}${word(fill.impact)}`,
        txHash,
      );
      this.book.openOrderIds = this.book.openOrderIds.filter((open) => open !== fill.id);
    }

    this.#log(
      [TOPICS.windowSettled, `0x${word(this.book.windowId)}`],
      `0x${word(result.amountIn)}${word(result.amountOut)}${word(result.referencePriceX96)}${word(result.executionPriceX96)}${word(SQRT_PRICE)}${word(10n ** 24n)}${word(76_014)}${word(21_000_001)}`,
      txHash,
    );

    // The post-trade state the leg returned becomes the mirror (FL-1).
    this.book.mirrorTick = 76_014;
    this.book.windowId += 1n;
    this.book.startBlock = this.head;
    this.book.blocksRemaining = 5;
    this.book.mirrorTimestamp = this.timestamp;
    this.book.referencePriceX96 = result.referencePriceX96;
    this.book.referenceL1Block = 21_000_001;
    this.book.mirrorAgeSlots = 0;
  }

  #log(topics: string[], data: string, transactionHash: string): void {
    this.logs.push({
      address: BOOK,
      topics,
      data,
      blockNumber: `0x${this.head.toString(16)}`,
      transactionHash,
      logIndex: `0x${this.logs.length.toString(16)}`,
    });
  }

  async call(method: string, params: readonly unknown[] = []): Promise<unknown> {
    switch (method) {
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const number = tag === "latest" || tag === "safe" ? this.head : Number(BigInt(tag));
        if (number > this.head) return null;
        return {
          number: `0x${number.toString(16)}`,
          timestamp: `0x${(this.timestamp - (this.head - number) * 2).toString(16)}`,
        };
      }
      case "eth_getLogs": {
        const filter = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        return this.logs.filter((log) => {
          const block = Number(BigInt(log.blockNumber));
          return block >= from && block <= to;
        });
      }
      case "eth_call":
        return this.#view((params[0] as { data: string }).data);
      default:
        throw new Error(`fake L2: unexpected ${method}`);
    }
  }

  #view(data: string): string {
    const selector = data.slice(0, 10);
    const argument = data.slice(10);
    const book = this.book;

    if (selector === encodeCall("windowId()")) return `0x${word(book.windowId)}`;
    if (selector === encodeCall("windowSlots()")) return `0x${word(book.slots)}`;
    if (selector === encodeCall("windowStartBlock()")) return `0x${word(book.startBlock)}`;
    if (selector === encodeCall("windowBlocksRemaining()")) return `0x${word(book.blocksRemaining)}`;
    if (selector === encodeCall("mirror()")) {
      return `0x${word(book.mirrorSqrtPrice)}${word(book.mirrorLiquidity)}${word(book.mirrorTick)}`;
    }
    if (selector === encodeCall("mirrorTimestamp()")) return `0x${word(book.mirrorTimestamp)}`;
    if (selector === encodeCall("latestPrice()")) {
      return `0x${word(book.referencePriceX96)}${word(book.referenceL1Block)}${word(book.mirrorAgeSlots)}`;
    }
    if (selector === encodeCall("openOrderIds()")) {
      const ids = book.openOrderIds.map((id) => hash(id)).join("");
      return `0x${word(32)}${word(book.openOrderIds.length)}${ids}`;
    }
    if (selector === encodeCall("orderOf(bytes32)")) {
      const id = `0x${argument}`;
      return `0x${hash(id)}${address(OWNERS.alice)}${word(0)}${word(10n ** 18n)}${word(1n)}${address(OWNERS.alice)}${word(4)}`;
    }
    if (selector === encodeCall("statusOf(bytes32)")) return `0x${word(1)}`;
    throw new Error(`fake L2: unexpected view ${selector}`);
  }
}

/** A minimal L1: a head, the settlement's receipt, and swaps to sample. */
export class FakeL1 implements JsonRpc {
  readonly name = "l1";
  head = 21_000_000;
  timestamp = 1_800_000_000;
  receipts = new Map<string, unknown>();
  blockReceipts = new Map<number, unknown[]>();

  /** A retail swap in a sampled block: what IX-3's median is measured from. */
  swap(block: number, from: string, gasUsed: number, gasPriceWei = 2_000_000_000): void {
    const receipts = this.blockReceipts.get(block) ?? [];
    receipts.push({
      transactionHash: `0x${word(receipts.length + block * 1000).slice(0, 64)}`,
      from,
      blockNumber: `0x${block.toString(16)}`,
      gasUsed: `0x${gasUsed.toString(16)}`,
      effectiveGasPrice: `0x${gasPriceWei.toString(16)}`,
      status: "0x1",
      logs: [{ topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"] }],
    });
    this.blockReceipts.set(block, receipts);
  }

  /** The settlement's own L1 transaction. */
  settlement(txHash: string, gasUsed: number, gasPriceWei = 2_000_000_000): void {
    this.receipts.set(txHash.toLowerCase(), {
      transactionHash: txHash.toLowerCase(),
      from: ROUTER,
      blockNumber: `0x${this.head.toString(16)}`,
      gasUsed: `0x${gasUsed.toString(16)}`,
      effectiveGasPrice: `0x${gasPriceWei.toString(16)}`,
      status: "0x1",
      logs: [],
    });
  }

  async call(method: string, params: readonly unknown[] = []): Promise<unknown> {
    switch (method) {
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const number = tag === "latest" || tag === "safe" ? this.head : Number(BigInt(tag));
        return { number: `0x${number.toString(16)}`, timestamp: `0x${this.timestamp.toString(16)}` };
      }
      case "eth_getBlockReceipts":
        return this.blockReceipts.get(Number(BigInt(params[0] as string))) ?? [];
      case "eth_getTransactionReceipt":
        return this.receipts.get((params[0] as string).toLowerCase()) ?? null;
      default:
        throw new Error(`fake L1: unexpected ${method}`);
    }
  }
}
