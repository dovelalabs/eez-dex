/**
 * The derived amortisation stream — RD-2 IX-3, FE-3, FE-6.
 *
 * FROZEN AT THE SCAFFOLD. Computed once, here, so every view agrees: the swap
 * panel's cost line (FE-3) and the theater's counter (FE-6) read the same
 * numbers, and the demo cannot quote a saving the stream does not support.
 */

import type { Hash32, Uint256 } from "./common.ts";
import type { Versioned } from "./version.ts";

/**
 * Where an order's direct-L1 counterfactual came from.
 *
 * `user_last_l1_swap` — the gas the user's own address last paid for a swap on
 * L1, and the only figure FE-3 may render as "your last L1 swap cost".
 * `median_retail_swap` — the median retail swap gas from the last sampled
 * window of L1 receipts, when the user has no observable swap.
 *
 * There is deliberately no fixed single-hop estimate: IX-3 forbids one,
 * because a made-up denominator would make the saving a made-up number.
 */
export const COUNTERFACTUAL_SOURCES = ["user_last_l1_swap", "median_retail_swap"] as const;

/** Which of the two the counterfactual came from. */
export type CounterfactualSource = (typeof COUNTERFACTUAL_SOURCES)[number];

/** One order's counterfactual, kept per order because its source differs per order. */
export interface OrderCounterfactual {
  readonly orderId: Hash32;
  readonly gasUsed: Uint256;
  readonly gasCostWei: Uint256;
  readonly source: CounterfactualSource;
}

/** What one settlement amortised. */
export interface Amortisation extends Versioned {
  readonly settlementId: Hash32;
  readonly windowId: string;
  /** Fills settled by this one cross-layer transaction. */
  readonly fills: number;
  readonly l1GasUsed: Uint256;
  readonly l1GasCostWei: Uint256;
  /** `l1GasCostWei / fills`, or null when there were no fills. */
  readonly gasPerFillWei: Uint256 | null;
  /** Σ of the per-order counterfactuals below. */
  readonly counterfactualGasCostWei: Uint256;
  /** `counterfactualGasCostWei - l1GasCostWei`. Negative is a real answer. */
  readonly savingsWei: string;
  readonly perOrder: readonly OrderCounterfactual[];
}
