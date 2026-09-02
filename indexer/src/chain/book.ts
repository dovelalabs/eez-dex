/**
 * `WindowBook` on L2, as the read side sees it — RD-2 IX-1, A.2, CT-7, CT-12.
 *
 * Five events and the views behind them. Topics and selectors are derived from
 * the signatures below rather than pasted in, so a signature that drifts from
 * `contracts/src/l2/WindowBook.sol` is a decode that stops matching rather
 * than one that quietly matches the wrong log.
 *
 * CT-12 is what makes this module small: `OrderFilled` carries the fee, the
 * route-fee share and the impact share **absolutely, in sell-asset units**, so
 * nothing here infers a deduction the chain did not state.
 */

import type { PoolState, Side } from "../../schema/index.ts";
import { AbiError, encodeCall, toAddress, toBigInt, toBool, toHash, toHashArray, toInt, toNumber, topic, word, words } from "./abi.ts";
import { ethCall, getLogs, type JsonRpc, type RawLog } from "./rpc.ts";

/** The event signatures the gateway decodes, verbatim from the contracts. */
export const EVENT_SIGNATURES = {
  orderPlaced: "OrderPlaced(bytes32,address,uint64,uint8,uint256,uint256,address,uint32)",
  orderCancelled: "OrderCancelled(bytes32,address,uint256)",
  orderExpired: "OrderExpired(bytes32,address,uint256,bool)",
  orderFilled: "OrderFilled(bytes32,uint256,uint256,uint256,uint256)",
  windowSettled: "WindowSettled(uint64,(uint256,uint256,uint256,uint256,(uint160,uint128,int24),uint64))",
} as const;

/** `topic0` for each of them. */
export const TOPICS: Readonly<Record<keyof typeof EVENT_SIGNATURES, string>> = {
  orderPlaced: topic(EVENT_SIGNATURES.orderPlaced),
  orderCancelled: topic(EVENT_SIGNATURES.orderCancelled),
  orderExpired: topic(EVENT_SIGNATURES.orderExpired),
  orderFilled: topic(EVENT_SIGNATURES.orderFilled),
  windowSettled: topic(EVENT_SIGNATURES.windowSettled),
};

/** A.1's `Side`, by name — the schema's convention, not the ordinal (A.1). */
function sideOf(ordinal: number): Side {
  if (ordinal === 0) return "SELL_A_FOR_B";
  if (ordinal === 1) return "SELL_B_FOR_A";
  throw new AbiError(`the ABI carried a Side the contracts do not define: ${ordinal}`);
}

/** A.1's `WindowResult`, decoded. */
export interface DecodedWindowResult {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly referencePriceX96: bigint;
  readonly executionPriceX96: bigint;
  readonly post: PoolState;
  readonly l1Block: number;
}

/** One decoded `WindowBook` log, with the position it was read at. */
export type BookLog =
  | {
      readonly kind: "order_placed";
      readonly at: LogPosition;
      readonly id: string;
      readonly owner: string;
      readonly windowId: string;
      readonly side: Side;
      readonly sellAmount: bigint;
      readonly minBuyAmount: bigint;
      readonly recipient: string;
      readonly expiresAfter: number;
    }
  | { readonly kind: "order_cancelled"; readonly at: LogPosition; readonly id: string; readonly owner: string; readonly refund: bigint }
  | {
      readonly kind: "order_expired";
      readonly at: LogPosition;
      readonly id: string;
      readonly owner: string;
      readonly refund: bigint;
      /** True when the sweep credited the L2 balance rather than `reclaim` paying out. */
      readonly credited: boolean;
    }
  | {
      readonly kind: "order_filled";
      readonly at: LogPosition;
      readonly id: string;
      readonly amountOut: bigint;
      readonly feeAmount: bigint;
      readonly routeFeeAmount: bigint;
      readonly impactAmount: bigint;
    }
  | {
      readonly kind: "window_settled";
      readonly at: LogPosition;
      readonly windowId: string;
      readonly result: DecodedWindowResult;
    };

/** Where a log sat, so the fold can order and de-duplicate it. */
export interface LogPosition {
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly transactionHash: string;
}

function position(log: RawLog): LogPosition {
  return {
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    transactionHash: log.transactionHash.toLowerCase(),
  };
}

/** Decodes one raw log, or null if it is not one of the five. */
export function decodeBookLog(log: RawLog): BookLog | null {
  const topic0 = log.topics[0]?.toLowerCase();
  const at = position(log);
  const data = words(log.data);

  switch (topic0) {
    case TOPICS.orderPlaced:
      return {
        kind: "order_placed",
        at,
        id: toHash(log.topics[1] ?? ""),
        owner: toAddress(log.topics[2] ?? ""),
        windowId: toBigInt(log.topics[3] ?? "").toString(),
        side: sideOf(toNumber(word(data, 0))),
        sellAmount: toBigInt(word(data, 1)),
        minBuyAmount: toBigInt(word(data, 2)),
        recipient: toAddress(word(data, 3)),
        expiresAfter: toNumber(word(data, 4)),
      };
    case TOPICS.orderCancelled:
      return {
        kind: "order_cancelled",
        at,
        id: toHash(log.topics[1] ?? ""),
        owner: toAddress(log.topics[2] ?? ""),
        refund: toBigInt(word(data, 0)),
      };
    case TOPICS.orderExpired:
      return {
        kind: "order_expired",
        at,
        id: toHash(log.topics[1] ?? ""),
        owner: toAddress(log.topics[2] ?? ""),
        refund: toBigInt(word(data, 0)),
        credited: toBool(word(data, 1)),
      };
    case TOPICS.orderFilled:
      return {
        kind: "order_filled",
        at,
        id: toHash(log.topics[1] ?? ""),
        amountOut: toBigInt(word(data, 0)),
        feeAmount: toBigInt(word(data, 1)),
        routeFeeAmount: toBigInt(word(data, 2)),
        impactAmount: toBigInt(word(data, 3)),
      };
    case TOPICS.windowSettled:
      return {
        kind: "window_settled",
        at,
        windowId: toBigInt(log.topics[1] ?? "").toString(),
        result: {
          amountIn: toBigInt(word(data, 0)),
          amountOut: toBigInt(word(data, 1)),
          referencePriceX96: toBigInt(word(data, 2)),
          executionPriceX96: toBigInt(word(data, 3)),
          post: {
            sqrtPriceX96: toBigInt(word(data, 4)).toString(),
            liquidity: toBigInt(word(data, 5)).toString(),
            tick: toInt(word(data, 6), 24),
          },
          l1Block: toNumber(word(data, 7)),
        },
      };
    default:
      return null;
  }
}

/** Every `WindowBook` log in a closed block range, in chain order. */
export async function readBookLogs(
  rpc: JsonRpc,
  book: string,
  fromBlock: number,
  toBlock: number,
): Promise<readonly BookLog[]> {
  const raw = await getLogs(rpc, book, fromBlock, toBlock);
  return raw
    .map(decodeBookLog)
    .filter((log): log is BookLog => log !== null)
    .sort((a, b) => a.at.blockNumber - b.at.blockNumber || a.at.logIndex - b.at.logIndex);
}

/** The open window and the mirror, as the book's views report them. */
export interface BookView {
  readonly windowId: string;
  readonly slots: number;
  readonly startBlock: number;
  readonly blocksRemaining: number;
  readonly mirror: PoolState;
  readonly mirrorTimestamp: number;
  readonly referencePriceX96: string;
  readonly referenceL1Block: number;
  readonly mirrorAgeSlots: number;
  readonly openOrderIds: readonly string[];
}

/** A.1's `Order`, as `orderOf` returns it. */
export interface BookOrder {
  readonly id: string;
  readonly owner: string;
  readonly side: Side;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly recipient: string;
  readonly expiresAfter: number;
}

/** `OrderStatus` in `WindowBook`: the ordinals, by name. */
export const ORDER_STATUSES = ["NONE", "OPEN", "FILLED", "CANCELLED", "EXPIRED"] as const;

/** One `eth_call` on the book, decoded by the caller. */
async function view(rpc: JsonRpc, book: string, signature: string, args: readonly string[] = []): Promise<readonly string[]> {
  return words(await ethCall(rpc, book, encodeCall(signature, args)));
}

/** Reads the open window and the mirror in one pass (FL-1, CT-8, CT-14). */
export async function readBookView(rpc: JsonRpc, book: string): Promise<BookView> {
  const [id, slots, startBlock, remaining, mirror, stamp, latest, open] = await Promise.all([
    view(rpc, book, "windowId()"),
    view(rpc, book, "windowSlots()"),
    view(rpc, book, "windowStartBlock()"),
    view(rpc, book, "windowBlocksRemaining()"),
    view(rpc, book, "mirror()"),
    view(rpc, book, "mirrorTimestamp()"),
    view(rpc, book, "latestPrice()"),
    ethCall(rpc, book, encodeCall("openOrderIds()")),
  ]);

  return {
    windowId: toBigInt(word(id, 0)).toString(),
    slots: toNumber(word(slots, 0)),
    startBlock: toNumber(word(startBlock, 0)),
    blocksRemaining: toNumber(word(remaining, 0)),
    mirror: {
      sqrtPriceX96: toBigInt(word(mirror, 0)).toString(),
      liquidity: toBigInt(word(mirror, 1)).toString(),
      tick: toInt(word(mirror, 2), 24),
    },
    mirrorTimestamp: toNumber(word(stamp, 0)),
    referencePriceX96: toBigInt(word(latest, 0)).toString(),
    referenceL1Block: toNumber(word(latest, 1)),
    mirrorAgeSlots: toNumber(word(latest, 2)),
    openOrderIds: toHashArray(open),
  };
}

/** One order as the book holds it, whatever its status (CT-7). */
export async function readOrder(rpc: JsonRpc, book: string, id: string): Promise<BookOrder> {
  const data = await view(rpc, book, "orderOf(bytes32)", [id]);
  return {
    id: toHash(word(data, 0)),
    owner: toAddress(word(data, 1)),
    side: sideOf(toNumber(word(data, 2))),
    sellAmount: toBigInt(word(data, 3)),
    minBuyAmount: toBigInt(word(data, 4)),
    recipient: toAddress(word(data, 5)),
    expiresAfter: toNumber(word(data, 6)),
  };
}

/** An id's `OrderStatus`, by name. */
export async function readOrderStatus(rpc: JsonRpc, book: string, id: string): Promise<(typeof ORDER_STATUSES)[number]> {
  const data = await view(rpc, book, "statusOf(bytes32)", [id]);
  const ordinal = toNumber(word(data, 0));
  const status = ORDER_STATUSES[ordinal];
  if (status === undefined) throw new AbiError(`unknown OrderStatus ${ordinal}`);
  return status;
}

/** The window an id was placed in, which is where it rolls from. */
export async function readPlacedWindow(rpc: JsonRpc, book: string, id: string): Promise<string> {
  const data = await view(rpc, book, "placedWindow(bytes32)", [id]);
  return toBigInt(word(data, 0)).toString();
}
