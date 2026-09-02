/**
 * The indicative quote and its cost line — RD-2 FL-2, FE-1, FE-3, EC-1.
 *
 * Two rules shape this module.
 *
 * **The quote is indicative and says so.** It is the mirror's curve applied to
 * what is left of the sell amount after EC-1's deductions, at the mirror's own
 * age — never a promise. The binding price is the `P0` the L1 leg returns
 * (FL-5), which is why the mirror's age and the window's countdown travel with
 * the quote as facts of the same rank (FL-2, FE-1).
 *
 * **The counterfactual is not computed here.** IX-3 computes the direct-L1
 * comparison once, in the indexer, so the swap panel's cost line (FE-3) and
 * the theater's counter (FE-6) cannot disagree; this module only chooses which
 * of the stream's figures applies to the user in front of it, and carries the
 * source through so the UI can say "your last L1 swap cost" only when it is
 * genuinely the user's own (IX-3).
 */

import type { CounterfactualSource, MirrorSnapshot, Side } from "@eez-dex/indexer/schema";

import type { FeeParams } from "../config.ts";
import { ageSlots, quote as mirrorQuote } from "./mirror.ts";
import { Q96, mulDiv, spotPriceX96 } from "./q96.ts";

/** EC-1's basis-point denominator, as the book has it. */
export const BPS_DENOMINATOR = 10_000n;

/** `WindowBook._protocolFee`: EC-1's two shapes, both in the sell asset (CT-12). */
export function protocolFee(fee: FeeParams, sellAmount: bigint, side: Side): bigint {
  if (fee.mode === "bps") return mulDiv(sellAmount, fee.bps, BPS_DENOMINATOR);
  return side === "SELL_A_FOR_B" ? fee.fixedA : fee.fixedB;
}

/** Why a sell amount cannot be quoted. Each is a sentence the panel prints. */
export type QuoteProblem =
  | { readonly kind: "no_mirror" }
  | { readonly kind: "no_amount" }
  | { readonly kind: "fee_exceeds_order" }
  | { readonly kind: "no_liquidity" };

/** The user's own figure, or the sampled median — IX-3 allows no third. */
export interface Counterfactual {
  readonly gasCostWei: bigint;
  readonly source: CounterfactualSource;
}

/** What one prospective order would cost and return. */
export interface Quote {
  readonly sellAmount: bigint;
  readonly side: Side;
  /** The EC-1 protocol fee, in the sell asset. */
  readonly fee: bigint;
  /**
   * This order's share of the window's route fee. Zero while
   * `ROUTE_FEE_MODEL=absorb`, which is the launch setting — and the cost line
   * shows the zero rather than dropping the row (FE-3, EC-1).
   */
  readonly routeFee: bigint;
  /** What actually reaches the curve: `sellAmount - fee - routeFee`. */
  readonly netIn: bigint;
  /** The indicative output against the mirror, rounded down (CT-12). */
  readonly amountOut: bigint;
  /** The price that output implies, B per A in Q96. */
  readonly priceX96: bigint;
  /** The mirror's spot, for the difference the size of the order makes. */
  readonly mirrorPriceX96: bigint;
  /** `amountOut` less the slippage setting — the `minBuyAmount` placed (FE-1). */
  readonly minBuyAmount: bigint;
  readonly slippageBps: number;
  /** The mirror's age at the moment quoted, in slots (CT-8). */
  readonly mirrorAgeSlots: number;
}

/** Everything the swap panel needs, or the reason there is nothing. */
export type QuoteResult = { readonly ok: true; readonly quote: Quote } | { readonly ok: false; readonly problem: QuoteProblem };

/** What to quote. */
export interface QuoteRequest {
  readonly mirror: MirrorSnapshot | null;
  readonly sellAmount: bigint;
  readonly side: Side;
  readonly slippageBps: number;
  readonly fee: FeeParams;
  /** The route fee this window would charge, in the sell asset. Zero when absorbed. */
  readonly routeFee?: bigint;
  /** Now, for the mirror's age. The stream's clock, never the browser's own. */
  readonly nowUnix: number;
}

/**
 * Quotes one order against the mirror.
 *
 * Failure is a value rather than an exception because every one of its causes
 * is a state the panel has to render honestly: no mirror yet, no amount typed,
 * a mirror with no liquidity (§7 preamble).
 */
export function buildQuote(request: QuoteRequest): QuoteResult {
  const { mirror, sellAmount, side, slippageBps, fee, nowUnix } = request;
  if (mirror === null) return { ok: false, problem: { kind: "no_mirror" } };
  if (sellAmount <= 0n) return { ok: false, problem: { kind: "no_amount" } };

  const protocol = protocolFee(fee, sellAmount, side);
  const routeFee = fee.routeFeeModel === "recover" ? (request.routeFee ?? 0n) : 0n;
  if (protocol + routeFee >= sellAmount) return { ok: false, problem: { kind: "fee_exceeds_order" } };

  const netIn = sellAmount - protocol - routeFee;
  let amountOut: bigint;
  try {
    amountOut = mirrorQuote(mirror.state, netIn, side);
  } catch {
    return { ok: false, problem: { kind: "no_liquidity" } };
  }
  if (amountOut === 0n) return { ok: false, problem: { kind: "no_liquidity" } };

  const slippage = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return {
    ok: true,
    quote: {
      sellAmount,
      side,
      fee: protocol,
      routeFee,
      netIn,
      amountOut,
      priceX96: impliedPriceX96(netIn, amountOut, side),
      mirrorPriceX96: spotPriceX96(mirror.state),
      minBuyAmount: mulDiv(amountOut, BPS_DENOMINATOR - slippage, BPS_DENOMINATOR),
      slippageBps: Number(slippage),
      mirrorAgeSlots: ageSlots(nowUnix, mirror.mirrorTimestamp),
    },
  };
}

/**
 * The price a net input and an output imply, B per A in Q96.
 *
 * The same derivation the gateway uses on a fill's emitted amounts, so a quote
 * and the fill it becomes are stated in one convention (A.1, CT-12).
 */
export function impliedPriceX96(netIn: bigint, amountOut: bigint, side: Side): bigint {
  if (netIn === 0n || amountOut === 0n) return 0n;
  return side === "SELL_A_FOR_B" ? mulDiv(amountOut, Q96, netIn) : mulDiv(netIn, Q96, amountOut);
}
