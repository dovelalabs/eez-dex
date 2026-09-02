/**
 * Just enough ABI to read the chain — RD-2 A.1, A.2, HX-2.
 *
 * The scenario reads `WindowBook`'s logs and a handful of views. Every one of
 * them is statically encoded (the widest is `WindowResult`, a nested static
 * tuple), and the one dynamic shape is `bytes32[]`, so the whole surface is
 * word slicing. That is why this file exists instead of a dependency: the
 * harness has to keep running when a registry is down, and a decoder it can
 * read end to end is a decoder it can trust the assertions of.
 *
 * Selectors and topics are derived from the signature at call time — nothing
 * is transcribed by hand, so a signature that drifts from the contract fails
 * loudly at the RPC rather than silently decoding the wrong log.
 */

import { fromHex, keccak256Utf8, toHex, word } from "./keccak.ts";

/** The `topic0` of an event signature. */
export function topic0(signature: string): string {
  return keccak256Utf8(signature);
}

/** The 4-byte selector of a function signature. */
export function selector(signature: string): string {
  return keccak256Utf8(signature).slice(0, 10);
}

/** A value this module can encode into one 32-byte word. */
export type Word = bigint | number | boolean | string;

function toWord(value: Word): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "boolean") return value ? 1n : 0n;
  return BigInt(value);
}

/** Calldata for a function whose arguments are all one word wide. */
export function encodeCall(signature: string, args: readonly Word[] = []): string {
  let data = selector(signature);
  for (const arg of args) data += toHex(word(toWord(arg))).slice(2);
  return data;
}

/** Splits ABI-encoded return data or log data into its 32-byte words. */
export function words(data: string): bigint[] {
  const bytes = fromHex(data);
  if (bytes.length % 32 !== 0) throw new Error(`abi: ${bytes.length} bytes is not a whole number of words`);
  const out: bigint[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    let value = 0n;
    for (let i = 0; i < 32; i += 1) value = (value << 8n) | BigInt(bytes[offset + i]!);
    out.push(value);
  }
  return out;
}

/** The `n`th word of some encoded data. */
export function wordAt(data: string, index: number): bigint {
  const all = words(data);
  const value = all[index];
  if (value === undefined) throw new Error(`abi: word ${index} is past the end of ${all.length} words`);
  return value;
}

/** A word read as a lower-case address. */
export function asAddress(value: bigint): string {
  return `0x${(value & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`;
}

/** A word read as a `bytes32`, lower case. */
export function asBytes32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** A word read as a two's-complement signed integer of `bits` width. */
export function asSigned(value: bigint, bits: number): bigint {
  const span = 1n << BigInt(bits);
  const masked = value & (span - 1n);
  return masked >= span / 2n ? masked - span : masked;
}

/** A `bytes32[]` return value: one offset word, one length word, the elements. */
export function asBytes32Array(data: string): string[] {
  const all = words(data);
  const offset = Number(all[0] ?? 0n) / 32;
  const length = Number(all[offset] ?? 0n);
  const out: string[] = [];
  for (let i = 0; i < length; i += 1) out.push(asBytes32(all[offset + 1 + i] ?? 0n));
  return out;
}

// --- the events the recorder reads ------------------------------------------

/**
 * `WindowBook`'s log surface (A.2). The signatures are the contract's, spelled
 * with the canonical type names the ABI hashes: `Side` is its `uint8`.
 */
export const EVENTS = {
  orderPlaced: "OrderPlaced(bytes32,address,uint64,uint8,uint256,uint256,address,uint32)",
  orderCancelled: "OrderCancelled(bytes32,address,uint256)",
  orderExpired: "OrderExpired(bytes32,address,uint256,bool)",
  orderFilled: "OrderFilled(bytes32,uint256,uint256,uint256,uint256)",
  windowSettled: "WindowSettled(uint64,(uint256,uint256,uint256,uint256,(uint160,uint128,int24),uint64))",
  withdrawn: "Withdrawn(address,address,uint256)",
} as const;

/** One log, as a JSON-RPC node returns it. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

/** A.1's `PoolState`, decoded. */
export interface PoolStateWords {
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly tick: number;
}

/** A.1's `WindowResult`, decoded. */
export interface WindowResultWords {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly referencePriceX96: bigint;
  readonly executionPriceX96: bigint;
  readonly post: PoolStateWords;
  readonly l1Block: number;
}

/** `WindowSettled`'s data: eight words, the nested tuple flattened. */
export function decodeWindowResult(data: string): WindowResultWords {
  const w = words(data);
  if (w.length < 8) throw new Error(`abi: WindowResult needs 8 words, got ${w.length}`);
  return {
    amountIn: w[0]!,
    amountOut: w[1]!,
    referencePriceX96: w[2]!,
    executionPriceX96: w[3]!,
    post: { sqrtPriceX96: w[4]!, liquidity: w[5]!, tick: Number(asSigned(w[6]!, 24)) },
    l1Block: Number(w[7]!),
  };
}
