/**
 * The mirror — RD-2 IX-2, FL-1, CT-6, CT-8, CT-14, FE-8.
 *
 * FROZEN AT THE SCAFFOLD.
 */

import type { PoolState, PriceX96, UnixSeconds } from "./common.ts";
import type { Versioned } from "./version.ts";

/** Why this snapshot exists. */
export const MIRROR_SOURCES = ["settlement", "refresh", "genesis"] as const;

/**
 * `settlement` — adopted from a window's `WindowResult` (FL-1).
 * `refresh` — a CT-6 empty settlement taken because the mirror aged past
 * `MIRROR_REFRESH_AGE`.
 * `genesis` — the state the book was deployed with.
 */
export type MirrorSource = (typeof MIRROR_SOURCES)[number];

/** The working copy of the real pool, as of one L1 block. */
export interface MirrorSnapshot extends Versioned {
  /** The window whose settlement produced it. */
  readonly windowId: string;
  readonly state: PoolState;
  /** `P0` as of this snapshot — what `latestPrice()` returns (CT-14). */
  readonly referencePriceX96: PriceX96;
  /** The L1 block the state was read in. */
  readonly l1Block: number;
  /** The Sync-block timestamp the age is measured from (CT-8). */
  readonly mirrorTimestamp: UnixSeconds;
  /**
   * `(now - mirrorTimestamp) / 12`, as the chain computes it. The L1 head is
   * not visible from L2, so this is the only age there is — and it is a
   * first-class fact in every quote (FL-2), never a footnote.
   */
  readonly ageSlots: number;
  readonly source: MirrorSource;
  readonly observedAtUnix: UnixSeconds;
}
