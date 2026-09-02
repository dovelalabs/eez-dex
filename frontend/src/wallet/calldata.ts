/**
 * The two calls this app can make — RD-2 FE-11, CT-7.
 *
 * The only write path is the user's own order placement and cancellation,
 * signed by their own wallet (FE-11). That is two functions on one contract, so
 * the encoding is written out rather than pulled in: an ABI library would be
 * more code than the calls it encodes, and every byte of what a user signs is
 * visible here.
 *
 * The selectors are constants and `test/calldata.test.ts` derives them from the
 * signatures beside them, so a signature that drifts from
 * `contracts/src/l2/WindowBook.sol` fails a test rather than sending a call
 * that reverts.
 */

import type { Side } from "@eez-dex/indexer/schema";

/** `WindowBook.place(Order)` — A.1's `Order`, whose members are all static. */
export const PLACE_SIGNATURE = "place((bytes32,address,uint8,uint256,uint256,address,uint32))";

/** Its 4-byte selector. */
export const PLACE_SELECTOR = "0xf49523c6";

/** `WindowBook.cancel(bytes32)`. */
export const CANCEL_SIGNATURE = "cancel(bytes32)";

/** Its 4-byte selector. */
export const CANCEL_SELECTOR = "0xc4d252f5";

/** A.1's `Side`, by its ordinal, which is what the ABI carries. */
export function sideOrdinal(side: Side): 0 | 1 {
  return side === "SELL_A_FOR_B" ? 0 : 1;
}

function word(value: bigint): string {
  if (value < 0n) throw new RangeError("the ABI has no negative words here");
  return value.toString(16).padStart(64, "0");
}

function addressWord(address: string): string {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new RangeError(`not an address: ${address}`);
  return hex.toLowerCase().padStart(64, "0");
}

function hashWord(hash: string): string {
  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new RangeError(`not a 32-byte hash: ${hash}`);
  return hex.toLowerCase();
}

/** The order a user places, in the fields they actually choose. */
export interface PlacedOrder {
  readonly side: Side;
  readonly sellAmount: bigint;
  /** The limit, net of fees and impact. Never filled below it (CT-10). */
  readonly minBuyAmount: bigint;
  /** An L2 address in the full form, an L1 address in the genesis form. */
  readonly recipient: string;
  /** Lifetime in windows. */
  readonly expiresAfter: number;
}

/**
 * Encodes `place`.
 *
 * `id` and `owner` are sent as zero: the id is `keccak256(owner, nonce)`
 * derived on-chain and never user-supplied, and the owner is `msg.sender`
 * (CT-7). Sending anything else in those two words would not change what the
 * contract stores — but it would suggest the caller believed it could.
 */
export function encodePlace(order: PlacedOrder): string {
  return (
    PLACE_SELECTOR +
    word(0n) +
    word(0n) +
    word(BigInt(sideOrdinal(order.side))) +
    word(order.sellAmount) +
    word(order.minBuyAmount) +
    addressWord(order.recipient) +
    word(BigInt(order.expiresAfter))
  );
}

/** Encodes `cancel(id)`. */
export function encodeCancel(orderId: string): string {
  return CANCEL_SELECTOR + hashWord(orderId);
}

/** A `uint256` as the minimal hex quantity `eth_sendTransaction` wants. */
export function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}
