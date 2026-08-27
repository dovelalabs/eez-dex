/**
 * The A.5 metric names, for readers that do not link the Rust crate.
 *
 * FROZEN AT THE SCAFFOLD. `settler/src/config.rs` is the source of truth;
 * `test/schema.test.ts` reads that file and fails if this list has drifted
 * from it, so "versioned in one place" (IX-2) survives having two languages.
 */

/** Every metric the settler publishes, in A.5's order. */
export const METRIC_NAMES = [
  "windows_total",
  "fills_per_settlement",
  "gas_per_fill_wei",
  "counterfactual_l1_gas_wei",
  "roll_rate",
  "mirror_age_slots",
  "time_to_settle_seconds",
  "escrow_invariant_drift_wei",
  "unposted_window",
  "selection_omitted_total",
  "impact_bps",
  "netting_ratio",
  "window_slots",
] as const;

/** A metric the settler publishes. */
export type MetricName = (typeof METRIC_NAMES)[number];

/** The `outcome` label of `windows_total`. */
export const WINDOW_OUTCOMES = ["settled", "evicted", "rolled_back", "empty"] as const;

/** One value of that label. */
export type WindowOutcome = (typeof WINDOW_OUTCOMES)[number];
