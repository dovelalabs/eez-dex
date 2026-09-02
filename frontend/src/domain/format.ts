/**
 * Turning chain integers into text — RD-2 FE-11.
 *
 * Every number the UI shows starts as a `bigint` and is formatted by integer
 * arithmetic. Nothing here goes through a double: a wei that rounds away in a
 * `Number` is a wei the user is told they did not pay, and FE-2 and TS-5 both
 * hold this app to the chain's own figures to the wei.
 *
 * The digits are rendered in a tabular-numeral face by the token set, so the
 * one thing formatting has to do is keep the fraction width fixed for a column
 * of related figures rather than trimming each one to taste (FE-11).
 */

import { Q96 } from "./q96.ts";

/** One ETH, and the rail's native unit. */
const WEI_PER_ETH = 10n ** 18n;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * A fixed-point amount as text, truncated — never rounded up — to `digits`.
 *
 * Truncation is the honest direction here for the same reason the contract
 * rounds outputs down (CT-12): a displayed amount should never be one the
 * user cannot actually have.
 */
export function formatUnits(amount: bigint, decimals: number, digits = 4): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = pow10(decimals);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const sign = negative ? "-" : "";
  const grouped = groupThousands(whole.toString());
  if (digits <= 0 || decimals === 0) return `${sign}${grouped}`;

  const shown = Math.min(digits, decimals);
  const text = (fraction / pow10(decimals - shown)).toString().padStart(shown, "0");
  return `${sign}${grouped}.${text}`;
}

/** Thousands separators, so a nine-figure notional is readable at a glance. */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Parses a typed decimal amount into the asset's base units.
 *
 * Returns null for anything that is not a plain non-negative decimal, so the
 * swap panel can say "that is not an amount" rather than quoting on a guess.
 * Excess precision is truncated, which is what the chain would do with it.
 */
export function parseUnits(input: string, decimals: number): bigint | null {
  const text = input.trim();
  if (text === "" || !/^\d*\.?\d*$/.test(text) || text === ".") return null;
  const [whole = "", fraction = ""] = text.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole === "" ? "0" : whole) * pow10(decimals) + BigInt(padded === "" ? "0" : padded);
}

/**
 * A Q96 price as B per A, in display units.
 *
 * The Q96 price is a ratio of base units; the pair's decimals turn it into the
 * ratio a human reads. Both conversions are exact integer work — the price is
 * scaled up before it is divided, never after.
 */
export function formatPriceX96(priceX96: bigint, decimalsA: number, decimalsB: number, digits = 4): string {
  if (priceX96 <= 0n) return formatUnits(0n, 0, digits);
  const scaled = (priceX96 * pow10(decimalsA) * pow10(digits)) / (Q96 * pow10(decimalsB));
  return formatUnits(scaled, digits, digits);
}

/** Wei as ETH, at the precision a gas figure is worth reading to. */
export function formatEth(wei: bigint, digits = 6): string {
  return formatUnits(wei, 18, digits);
}

/** Wei as gwei — the unit a gas price is quoted in. */
export function formatGwei(wei: bigint, digits = 2): string {
  return formatUnits(wei, 9, digits);
}

/**
 * A wei figure at whichever of the two scales carries information.
 *
 * Gas costs on a devnet are small enough that ETH at six places is all zeros,
 * and on mainnet gwei is six digits of noise. The threshold picks the one that
 * says something; both are the same number.
 */
export function formatWeiCost(wei: bigint): string {
  return wei >= WEI_PER_ETH / 1_000_000n ? `${formatEth(wei)} ETH` : `${formatGwei(wei)} gwei`;
}

/** A ratio in [0, 1] as a percentage, for netting and roll rates. */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A signed basis-point figure, with the sign kept: drift has a direction. */
export function formatBps(bps: number, digits = 1): string {
  return `${bps > 0 ? "+" : ""}${bps.toFixed(digits)} bp`;
}

/** An address, shortened the way every wallet shortens it. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A hash, shortened. */
export function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Seconds as `m:ss`, for a countdown that has to stay legible while it moves. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole}s` : `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** A unix timestamp as a wall clock, in the reader's own zone. */
export function formatClock(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour12: false });
}
