/**
 * The settlement — RD-2 IX-2, A.1, A.3, SV-4.
 *
 * FROZEN AT THE SCAFFOLD.
 */

import type { Hash32, PoolState, PriceX96, Side, Uint256, UnixSeconds } from "./common.ts";
import type { Amortisation } from "./amortisation.ts";
import type { Versioned } from "./version.ts";

/** A.1's `WindowLeg`, built on L2 by `settleWindow` — never by the settler. */
export interface WindowLeg {
  readonly windowId: string;
  readonly residualSide: Side;
  /** Net amount to swap on L1 after crossing. Zero for a CT-6 refresh. */
  readonly residualIn: Uint256;
  /** The tightest sell-side limit among the selected orders. */
  readonly minPriceX96: PriceX96;
  /** The tightest buy-side limit among them. */
  readonly maxPriceX96: PriceX96;
  /** A unix timestamp, checked on L1 against `block.timestamp` (CT-1). */
  readonly deadline: UnixSeconds;
}

/** A.1's `WindowResult`, as the composer recorded it. */
export interface WindowResult {
  readonly amountIn: Uint256;
  readonly amountOut: Uint256;
  /** `P0`: the pre-trade spot read inside the leg. Every crossed fill clears here. */
  readonly referencePriceX96: PriceX96;
  /** The residual's realised average. `impact = P0 - this`, and the residual side pays it. */
  readonly executionPriceX96: PriceX96;
  /** Becomes the next mirror. */
  readonly post: PoolState;
  readonly l1Block: number;
}

/** What the L1 leg actually cost, from the receipt. */
export interface L1Receipt {
  readonly txHash: Hash32;
  readonly blockNumber: number;
  readonly gasUsed: Uint256;
  readonly effectiveGasPriceWei: Uint256;
  readonly gasCostWei: Uint256;
  readonly status: "success" | "reverted";
}

/**
 * How a settlement ended. These are the window's own outcomes (A.4) and the
 * `outcome` label of `windows_total` (A.5).
 */
export const SETTLEMENT_OUTCOMES = ["submitted", "settled", "evicted", "rolled_back"] as const;

/** Where a settlement got to. */
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

/**
 * Why a settlement rolled back. Three different framework paths with one L2
 * observable — blocks un-happen and events go non-canonical — and the third
 * differs from the others in the only way that costs money (SV-4).
 */
export const ROLLBACK_CAUSES = ["bundle_missed", "reorg", "postbatch_skip"] as const;

/** The distinction the reconciler draws. */
export type RollbackCause = (typeof ROLLBACK_CAUSES)[number];

/** One window's trip to L1 and back. */
export interface Settlement extends Versioned {
  /** The L2 `settleWindow` transaction hash. */
  readonly id: Hash32;
  readonly windowId: string;
  readonly outcome: SettlementOutcome;
  readonly leg: WindowLeg;
  /** Present once the L1 leg returned; null while submitted, or if evicted. */
  readonly result: WindowResult | null;
  /**
   * Null when there was no L1 transaction at all — which is exactly what
   * poison eviction means, and what makes free failure legible (FL-7, FE-7).
   */
  readonly l1Receipt: L1Receipt | null;
  readonly rollbackCause: RollbackCause | null;
  /**
   * True when L1 gas was spent despite the window not settling: the
   * `postBatch` skip case, and the one rollback that is not free (SV-4).
   */
  readonly l1GasSpent: boolean;
  /** The orders this settlement filled, in ascending id order. */
  readonly filledOrderIds: readonly Hash32[];
  /** Selected ids that did not fill because they were no longer open (CT-9). */
  readonly droppedOrderIds: readonly Hash32[];
  readonly submittedAtUnix: UnixSeconds;
  readonly settledAtUnix: UnixSeconds | null;
  /** IX-3's derived figures. Null until the L1 receipt is in. */
  readonly amortisation: Amortisation | null;
}
