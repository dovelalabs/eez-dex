/**
 * What the scenario saw — the seam between reading a chain and recording a run.
 *
 * An observation is one raw fact: a block, a log, a receipt, or a conclusion
 * the reconciler's own evidence forced (an eviction, a rollback). It carries no
 * derived state at all. Everything the IX-2 schema asks for — an order's
 * current state, a window's netting ratio, the roll count, the amortisation —
 * is computed by {@link ./record.ts} from a sequence of these.
 *
 * Splitting it this way is what makes HX-5 testable without an enclave: the
 * recorder is a pure fold, so the four windows Phase 5 needs (settled, rolled,
 * evicted, rolled back) can be driven from an observation log, and the same
 * recorder runs over a real one.
 */

import type { Address, Hash32, PoolState, PriceX96, Side, Uint256, UnixSeconds } from "../../indexer/schema/index.ts";
import type { L1Receipt, RollbackCause, WindowLeg, WindowResult } from "../../indexer/schema/index.ts";
import type { CounterfactualSource } from "../../indexer/schema/index.ts";
import type { WindowSlots } from "../../indexer/schema/index.ts";

/** Which build profile the run was made under (RD-2 §1). */
export type Profile = "full" | "genesis";

/** Every observation is stamped with the unix second it was observed at. */
export interface Observed {
  readonly at: UnixSeconds;
}

/** The book as deployed: the first window, and the mirror it opened with. */
export interface GenesisObservation extends Observed {
  readonly kind: "genesis";
  readonly profile: Profile;
  readonly l2Block: number;
  readonly windowId: string;
  readonly slots: WindowSlots;
  readonly mirror: PoolState;
  readonly referencePriceX96: PriceX96;
  readonly l1Block: number;
}

/** An L2 block was produced — the 2 s tick. */
export interface L2BlockObservation extends Observed {
  readonly kind: "l2_block";
  readonly l2Block: number;
}

/** An L1 slot boundary — the 12 s clock. */
export interface SlotObservation extends Observed {
  readonly kind: "l1_slot";
  readonly l1Block: number;
}

/** `OrderPlaced` (CT-7). */
export interface OrderPlacedObservation extends Observed {
  readonly kind: "order_placed";
  readonly l2Block: number;
  readonly id: Hash32;
  readonly owner: Address;
  readonly side: Side;
  readonly sellAmount: Uint256;
  readonly minBuyAmount: Uint256;
  readonly recipient: Address;
  readonly expiresAfter: number;
  readonly windowId: string;
}

/** `OrderCancelled` — terminal, at any time while open (CT-7). */
export interface OrderCancelledObservation extends Observed {
  readonly kind: "order_cancelled";
  readonly l2Block: number;
  readonly id: Hash32;
}

/** `OrderExpired` — by `reclaim` or by the settlement sweep. */
export interface OrderExpiredObservation extends Observed {
  readonly kind: "order_expired";
  readonly l2Block: number;
  readonly id: Hash32;
}

/**
 * The ids the settler put in `settleWindow`'s calldata — its suggestion, not
 * the fill set (FL-8). Decoded from the transaction, so the scenario can audit
 * the selection against what was fillable (EC-4).
 */
export interface SelectionObservation extends Observed {
  readonly kind: "selection";
  readonly l2Block: number;
  readonly windowId: string;
  readonly orderIds: readonly Hash32[];
}

/** A settlement went to the L2->L1 front (SV-3). */
export interface SettlementSubmittedObservation extends Observed {
  readonly kind: "settlement_submitted";
  readonly l2Block: number;
  readonly txHash: Hash32;
  readonly windowId: string;
  readonly leg: WindowLeg;
}

/** `WindowSettled` (CT-9). */
export interface WindowSettledObservation extends Observed {
  readonly kind: "window_settled";
  readonly l2Block: number;
  readonly txHash: Hash32;
  readonly windowId: string;
  readonly result: WindowResult;
}

/** `OrderFilled` — every deduction absolute, in sell-asset units (CT-12). */
export interface OrderFilledObservation extends Observed {
  readonly kind: "order_filled";
  readonly l2Block: number;
  readonly txHash: Hash32;
  readonly id: Hash32;
  readonly amountOut: Uint256;
  readonly feeAmount: Uint256;
  readonly routeFeeAmount: Uint256;
  readonly impactAmount: Uint256;
}

/** The L1 leg's receipt, keyed by the L2 settlement transaction it rode in. */
export interface L1ReceiptObservation extends Observed {
  readonly kind: "l1_receipt";
  readonly txHash: Hash32;
  readonly receipt: L1Receipt;
}

/**
 * The settlement was poison-evicted at compose time: it never reached L1, so
 * there is no receipt and no L1 gas (FL-7). `txHash` is the L2 transaction that
 * was evicted, when the front named one.
 */
export interface EvictionObservation extends Observed {
  readonly kind: "settlement_evicted";
  readonly l2Block: number;
  readonly windowId: string;
  readonly txHash: Hash32 | null;
  /** Why it would have reverted, as the scenario induced it. */
  readonly reason: string;
}

/**
 * The window settled and then un-settled (SV-4). `postbatch_skip` is the one
 * cause that spent L1 gas, which is the distinction the whole row exists for.
 */
export interface RollbackObservation extends Observed {
  readonly kind: "settlement_rolled_back";
  readonly l2Block: number;
  readonly windowId: string;
  readonly txHash: Hash32;
  readonly cause: RollbackCause;
  readonly l1GasSpent: boolean;
}

/** One order's direct-L1 counterfactual, as observed on L1 (IX-3). */
export interface CounterfactualObservation extends Observed {
  readonly kind: "counterfactual";
  readonly orderId: Hash32;
  readonly gasUsed: Uint256;
  readonly gasCostWei: Uint256;
  readonly source: CounterfactualSource;
}

/** Everything the scenario can observe. */
export type Observation =
  | GenesisObservation
  | L2BlockObservation
  | SlotObservation
  | OrderPlacedObservation
  | OrderCancelledObservation
  | OrderExpiredObservation
  | SelectionObservation
  | SettlementSubmittedObservation
  | WindowSettledObservation
  | OrderFilledObservation
  | L1ReceiptObservation
  | EvictionObservation
  | RollbackObservation
  | CounterfactualObservation;

/** Reads an observation log: one JSON object per line, blank lines ignored. */
export function parseObservationLog(text: string): Observation[] {
  const out: Observation[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    try {
      out.push(JSON.parse(trimmed) as Observation);
    } catch (error) {
      throw new Error(`observation log line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return out;
}

/** Writes an observation log the same way. */
export function formatObservationLog(observations: readonly Observation[]): string {
  return observations.map((observation) => JSON.stringify(observation)).join("\n") + "\n";
}
