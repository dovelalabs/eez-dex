/**
 * Reading the two chains — RD-2 HX-2, HX-3, IX-1's inputs.
 *
 * JSON-RPC over `fetch`, and the ABI decoding in {@link ./abi.ts}. The shell
 * brings the enclave up and drives the ops; everything that has to *read* the
 * chain and turn it into observations lives here, because a harness that parses
 * `cast` output in bash cannot be tested without a chain, and this can.
 *
 * The transport is an interface for exactly that reason: the tests drive the
 * readers over a recorded set of responses, and the enclave run drives them
 * over HTTP.
 */

import {
  EVENTS,
  asAddress,
  asBytes32,
  asBytes32Array,
  asSigned,
  decodeWindowResult,
  encodeCall,
  topic0,
  wordAt,
  words,
} from "./abi.ts";
import type { RawLog, WindowResultWords } from "./abi.ts";
import { fromBig } from "./math.ts";
import type { PoolState, Side } from "../../indexer/schema/index.ts";

/** A JSON-RPC transport: one method, so a test can be a function. */
export type Transport = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** An HTTP transport with the error handling a devnet needs. */
export function httpTransport(url: string): Transport {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status} from ${url}`);
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function toBigFromHex(value: unknown): bigint {
  if (typeof value !== "string") throw new Error(`expected a hex quantity, got ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** One chain, read-only. */
export class Chain {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async blockNumber(): Promise<number> {
    return Number(toBigFromHex(await this.transport("eth_blockNumber", [])));
  }

  async chainId(): Promise<number> {
    return Number(toBigFromHex(await this.transport("eth_chainId", [])));
  }

  /** A block's timestamp, in unix seconds. */
  async blockTimestamp(block: number): Promise<number> {
    const result = (await this.transport("eth_getBlockByNumber", [hex(block), false])) as {
      timestamp: string;
    } | null;
    if (result === null) throw new Error(`no block ${block}`);
    return Number(toBigFromHex(result.timestamp));
  }

  /** `eth_call` against the head, returning the raw return data. */
  async call(to: string, data: string): Promise<string> {
    const result = await this.transport("eth_call", [{ to, data }, "latest"]);
    if (typeof result !== "string") throw new Error(`eth_call to ${to} returned ${JSON.stringify(result)}`);
    return result;
  }

  /** One word of a view's return. */
  async callWord(to: string, signature: string, args: readonly (bigint | string)[] = [], index = 0): Promise<bigint> {
    return wordAt(await this.call(to, encodeCall(signature, args)), index);
  }

  /** Logs of one address over a block range. */
  async logs(address: string, from: number, to: number, topics: readonly (string | null)[] = []): Promise<RawLog[]> {
    const result = await this.transport("eth_getLogs", [
      { address, fromBlock: hex(from), toBlock: hex(to), topics },
    ]);
    return result as RawLog[];
  }

  /** A transaction, or null if the node has never seen it. */
  async transaction(hash: string): Promise<{ to: string | null; input: string } | null> {
    const result = (await this.transport("eth_getTransactionByHash", [hash])) as {
      to: string | null;
      input: string;
    } | null;
    return result;
  }

  /** A transaction's input, for decoding what the settler actually submitted. */
  async transactionInput(hash: string): Promise<string> {
    const result = await this.transaction(hash);
    if (result === null) throw new Error(`no transaction ${hash}`);
    return result.input;
  }

  /** A receipt, with the two numbers an L1 leg's cost is made of. */
  async receipt(hash: string): Promise<{
    blockNumber: number;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    status: "success" | "reverted";
  } | null> {
    const result = (await this.transport("eth_getTransactionReceipt", [hash])) as {
      blockNumber: string;
      gasUsed: string;
      effectiveGasPrice: string;
      status: string;
    } | null;
    if (result === null) return null;
    return {
      blockNumber: Number(toBigFromHex(result.blockNumber)),
      gasUsed: toBigFromHex(result.gasUsed),
      effectiveGasPrice: toBigFromHex(result.effectiveGasPrice),
      status: toBigFromHex(result.status) === 1n ? "success" : "reverted",
    };
  }

  /** How many transactions a block carried — EC-5's bundle arithmetic. */
  async blockTransactions(block: number): Promise<string[]> {
    const result = (await this.transport("eth_getBlockByNumber", [hex(block), false])) as {
      transactions: string[];
    } | null;
    return result?.transactions ?? [];
  }
}

// --- the views the assertions read -------------------------------------------

/** `MockPool.slot0()` and `liquidity()`, as A.1's `PoolState`. */
export async function readPool(chain: Chain, pool: string): Promise<PoolState> {
  const slot0 = await chain.call(pool, encodeCall("slot0()"));
  const slot0Words = words(slot0);
  const liquidity = await chain.callWord(pool, "liquidity()");
  return {
    sqrtPriceX96: fromBig(slot0Words[0] ?? 0n),
    liquidity: fromBig(liquidity),
    tick: Number(asSigned(slot0Words[1] ?? 0n, 24)),
  };
}

/** `WindowBook.mirror()` — the working copy the quotes are taken against. */
export async function readMirror(chain: Chain, book: string): Promise<PoolState> {
  const data = await chain.call(book, encodeCall("mirror()"));
  const mirror = words(data);
  return {
    sqrtPriceX96: fromBig(mirror[0] ?? 0n),
    liquidity: fromBig(mirror[1] ?? 0n),
    tick: Number(asSigned(mirror[2] ?? 0n, 24)),
  };
}

/** The CT-13 ledger for one asset, as the assertions want it. */
export async function readEscrowLedger(
  chain: Chain,
  book: string,
  asset: string,
): Promise<Record<string, string>> {
  const read = async (signature: string): Promise<string> =>
    fromBig(await chain.callWord(book, signature, [asset]));
  const drift = await chain.callWord(book, "escrowInvariantDrift(address)", [asset]);
  return {
    asset,
    escrowed: await read("escrowed(address)"),
    feesAccrued: await read("feesAccrued(address)"),
    dustAccrued: await read("dustAccrued(address)"),
    credited: await read("credited(address)"),
    deposits: await read("deposits(address)"),
    released: await read("released(address)"),
    withdrawn: await read("withdrawn(address)"),
    drift: asSigned(drift, 256).toString(10),
  };
}

/** `WindowBook.balanceOf(asset, owner)` — the full form's delivered output. */
export async function readBalance(
  chain: Chain,
  book: string,
  asset: string,
  owner: string,
): Promise<string> {
  return fromBig(await chain.callWord(book, "balanceOf(address,address)", [asset, owner]));
}

/** The open order ids, and each order behind them. */
export async function readOpenOrders(
  chain: Chain,
  book: string,
): Promise<{ id: string; side: Side; sellAmount: string; minBuyAmount: string }[]> {
  const ids = asBytes32Array(await chain.call(book, encodeCall("openOrderIds()")));
  const orders: { id: string; side: Side; sellAmount: string; minBuyAmount: string }[] = [];
  for (const id of ids) {
    const data = await chain.call(book, encodeCall("orderOf(bytes32)", [id]));
    const order = words(data);
    orders.push({
      id,
      side: (order[2] ?? 0n) === 0n ? "SELL_A_FOR_B" : "SELL_B_FOR_A",
      sellAmount: fromBig(order[3] ?? 0n),
      minBuyAmount: fromBig(order[4] ?? 0n),
    });
  }
  return orders;
}

// --- the logs the recorder is folded from -------------------------------------

/** One decoded `WindowBook` log, in the shape {@link ./observe.ts} folds. */
export type BookLog =
  | {
      kind: "OrderPlaced";
      block: number;
      txHash: string;
      logIndex: number;
      id: string;
      owner: string;
      windowId: string;
      side: Side;
      sellAmount: string;
      minBuyAmount: string;
      recipient: string;
      expiresAfter: number;
    }
  | { kind: "OrderCancelled"; block: number; txHash: string; logIndex: number; id: string }
  | { kind: "OrderExpired"; block: number; txHash: string; logIndex: number; id: string }
  | {
      kind: "OrderFilled";
      block: number;
      txHash: string;
      logIndex: number;
      id: string;
      amountOut: string;
      feeAmount: string;
      routeFeeAmount: string;
      impactAmount: string;
    }
  | {
      kind: "WindowSettled";
      block: number;
      txHash: string;
      logIndex: number;
      windowId: string;
      result: WindowResultWords;
    };

/** Every `WindowBook` log in a block range, in chain order. */
export async function readBookLogs(chain: Chain, book: string, from: number, to: number): Promise<BookLog[]> {
  const raw = await chain.logs(book, from, to);
  const topics = {
    placed: topic0(EVENTS.orderPlaced),
    cancelled: topic0(EVENTS.orderCancelled),
    expired: topic0(EVENTS.orderExpired),
    filled: topic0(EVENTS.orderFilled),
    settled: topic0(EVENTS.windowSettled),
  };

  const decoded: BookLog[] = [];
  for (const log of raw) {
    const block = Number(BigInt(log.blockNumber));
    const logIndex = Number(BigInt(log.logIndex));
    const at = { block, txHash: log.transactionHash, logIndex };
    const [topic, first, second] = log.topics;
    const data = words(log.data);

    switch (topic) {
      case topics.placed:
        decoded.push({
          kind: "OrderPlaced",
          ...at,
          id: asBytes32(BigInt(first ?? "0x0")),
          owner: asAddress(BigInt(second ?? "0x0")),
          windowId: fromBig(BigInt(log.topics[3] ?? "0x0")),
          side: (data[0] ?? 0n) === 0n ? "SELL_A_FOR_B" : "SELL_B_FOR_A",
          sellAmount: fromBig(data[1] ?? 0n),
          minBuyAmount: fromBig(data[2] ?? 0n),
          recipient: asAddress(data[3] ?? 0n),
          expiresAfter: Number(data[4] ?? 0n),
        });
        break;
      case topics.cancelled:
        decoded.push({ kind: "OrderCancelled", ...at, id: asBytes32(BigInt(first ?? "0x0")) });
        break;
      case topics.expired:
        decoded.push({ kind: "OrderExpired", ...at, id: asBytes32(BigInt(first ?? "0x0")) });
        break;
      case topics.filled:
        decoded.push({
          kind: "OrderFilled",
          ...at,
          id: asBytes32(BigInt(first ?? "0x0")),
          amountOut: fromBig(data[0] ?? 0n),
          feeAmount: fromBig(data[1] ?? 0n),
          routeFeeAmount: fromBig(data[2] ?? 0n),
          impactAmount: fromBig(data[3] ?? 0n),
        });
        break;
      case topics.settled:
        decoded.push({
          kind: "WindowSettled",
          ...at,
          windowId: fromBig(BigInt(first ?? "0x0")),
          result: decodeWindowResult(log.data),
        });
        break;
      default:
        break;
    }
  }

  decoded.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return decoded;
}

/**
 * The order ids the settler suggested, decoded from `settleWindow`'s calldata.
 *
 * FL-8 calls the list a suggestion and CT-9 makes the contract rebuild the
 * selection from what is still open, so the two can differ — which is exactly
 * what the cancel-in-the-Sync-block row is about. Reading the calldata is the
 * only way to see the difference.
 */
export function decodeSettleWindow(input: string): { orderIds: string[]; deadline: number } {
  const body = `0x${input.slice(10)}`;
  const all = words(body);
  const offset = Number(all[0] ?? 0n) / 32;
  const deadline = Number(all[1] ?? 0n);
  const length = Number(all[offset] ?? 0n);
  const orderIds: string[] = [];
  for (let i = 0; i < length; i += 1) orderIds.push(asBytes32(all[offset + 1 + i] ?? 0n));
  return { orderIds, deadline };
}
