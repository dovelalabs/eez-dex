/**
 * The slice of ABI coding this gateway needs — RD-2 IX-1.
 *
 * The indexer reads two contracts and decodes five events; it never signs and
 * never sends, so what is needed is word decoding, one dynamic `bytes32[]`
 * return, and calldata for a view with at most one word of arguments. The rest
 * of the ABI is deliberately absent: a decoder this service cannot exercise is
 * a decoder nothing here tests.
 *
 * Every quantity leaves this module as a `bigint` or a lower-case hex string;
 * nothing that could exceed 2^53 is turned into a double (`schema/common.ts`).
 */

import { keccak256Hex } from "./keccak.ts";

/** A value read out of one ABI word. */
export type Hex = string;

/** The four-byte selector of a function signature, 0x-prefixed. */
export function selector(signature: string): Hex {
  return keccak256Hex(signature).slice(0, 10);
}

/** The `topic0` of an event signature. */
export function topic(signature: string): Hex {
  return keccak256Hex(signature);
}

/** Strips `0x` and lower-cases; throws on anything that is not hex. */
function body(hex: Hex): string {
  const value = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(value)) throw new AbiError(`not hex: ${hex}`);
  return value.toLowerCase();
}

/** Returned data was not the shape the signature promised. */
export class AbiError extends Error {}

/** Splits ABI-encoded data into 32-byte words. Trailing bytes are an error. */
export function words(data: Hex): readonly Hex[] {
  const value = body(data);
  if (value.length % 64 !== 0) throw new AbiError(`not a whole number of words: ${data}`);
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 64) out.push(`0x${value.slice(i, i + 64)}`);
  return out;
}

/** The word at `index`, or an error naming what was missing. */
export function word(data: readonly Hex[], index: number): Hex {
  const value = data[index];
  if (value === undefined) throw new AbiError(`expected at least ${index + 1} words, got ${data.length}`);
  return value;
}

/** One word as an unsigned integer. */
export function toBigInt(w: Hex): bigint {
  return BigInt(w);
}

/**
 * One word as a signed integer of `bits` bits — `int24` for a tick.
 *
 * The ABI sign-extends a narrow signed type across the whole word, so the word
 * is read as an `int256` and then checked against the declared width: a tick
 * that does not fit `int24` is a decode against the wrong signature, not a
 * very large tick.
 */
export function toInt(w: Hex, bits: number): number {
  const raw = BigInt(w);
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const limit = 1n << BigInt(bits - 1);
  if (signed >= limit || signed < -limit) throw new AbiError(`does not fit int${bits}: ${w}`);
  return Number(signed);
}

/** One word as a count small enough for a double — block heights, timestamps. */
export function toNumber(w: Hex): number {
  const value = BigInt(w);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AbiError(`${w} does not fit a double`);
  return Number(value);
}

/** One word as a 20-byte address, lower case. */
export function toAddress(w: Hex): Hex {
  return `0x${body(w).slice(24)}`;
}

/** One word as a bool. */
export function toBool(w: Hex): boolean {
  return BigInt(w) !== 0n;
}

/** One word as a 32-byte hash — an order id, lower case (CT-7). */
export function toHash(w: Hex): Hex {
  return `0x${body(w)}`;
}

/**
 * A `bytes32[]` return: head offset, length, then the items.
 *
 * `openOrderIds()` is the only dynamic return the gateway reads.
 */
export function toHashArray(data: Hex): readonly Hex[] {
  const all = words(data);
  const offset = Number(toBigInt(word(all, 0))) / 32;
  const length = Number(toBigInt(word(all, offset)));
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(toHash(word(all, offset + 1 + i)));
  return out;
}

/** Left-pads a hex value into one ABI word. */
function pad(value: Hex): string {
  const raw = body(value);
  if (raw.length > 64) throw new AbiError(`wider than a word: ${value}`);
  return raw.padStart(64, "0");
}

/**
 * Calldata for a view: its selector, then each argument in one word.
 *
 * Only static single-word arguments are supported, which is every view the
 * gateway calls (`orderOf(bytes32)`, `statusOf(bytes32)`).
 */
export function encodeCall(signature: string, args: readonly Hex[] = []): Hex {
  return `${selector(signature)}${args.map(pad).join("")}`;
}
