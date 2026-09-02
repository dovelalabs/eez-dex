/**
 * The A.5 metrics, recomputed from the chain — RD-2 A.5, EC-4.
 *
 * The scenario does not read the settler's registry and assert on it. It
 * observes the same chain the settler did and derives the same figures itself,
 * because a settler that mis-selects is exactly the failure EC-4 asks the
 * harness to catch: an audit that trusts the audited party's own numbers is
 * not an audit. `selection_omitted_total` and `escrow_invariant_drift_wei` are
 * the two that must be zero, and both are on-chain observable.
 *
 * The names are the frozen ones. They come from `indexer/schema/metrics.ts`,
 * which the indexer's own test pins to `settler/src/config.rs`, so nothing
 * here can invent a metric no consumer is looking for. The value kinds and the
 * `name{label="value"}` key shape mirror `settler/src/metrics.rs`: counters
 * total, gauges hold their last observation, and per-settlement metrics
 * publish their mean.
 */

import { METRIC_NAMES, WINDOW_OUTCOMES } from "../../indexer/schema/index.ts";
import type { MetricName, WindowOutcome } from "../../indexer/schema/index.ts";

/** `windows_total{outcome="settled"}` and friends. */
export function windowOutcomeKey(outcome: WindowOutcome): string {
  return `windows_total{outcome="${outcome}"}`;
}

/** The per-settlement metrics: published as a mean over the run. */
const OBSERVED: readonly MetricName[] = [
  "fills_per_settlement",
  "gas_per_fill_wei",
  "counterfactual_l1_gas_wei",
  "time_to_settle_seconds",
  "impact_bps",
  "netting_ratio",
];

/** The metrics that accumulate rather than replace. */
const COUNTERS: readonly MetricName[] = ["selection_omitted_total"];

type Value =
  | { readonly kind: "counter"; total: number }
  | { readonly kind: "gauge"; value: number }
  | { readonly kind: "observed"; sum: number; count: number; last: number };

/**
 * The registry, with every A.5 metric present at zero from the first tick.
 *
 * Present-at-zero is the same choice the settler makes and for the same
 * reason: a reader that cannot tell "no windows have settled" from "this run
 * does not publish that metric" cannot tell a quiet chain from a broken one.
 */
export class MetricsRegistry {
  private readonly values = new Map<string, Value>();

  constructor() {
    for (const outcome of WINDOW_OUTCOMES) {
      this.values.set(windowOutcomeKey(outcome), { kind: "counter", total: 0 });
    }
    for (const name of METRIC_NAMES) {
      if (name === "windows_total") continue;
      if (OBSERVED.includes(name)) this.values.set(name, { kind: "observed", sum: 0, count: 0, last: 0 });
      else if (COUNTERS.includes(name)) this.values.set(name, { kind: "counter", total: 0 });
      else this.values.set(name, { kind: "gauge", value: 0 });
    }
  }

  /** Counts one window under its A.4 outcome. */
  recordWindow(outcome: WindowOutcome): void {
    this.increment(windowOutcomeKey(outcome), 1);
  }

  /** Adds to a counter. */
  increment(key: string, by: number): void {
    const entry = this.values.get(key) ?? { kind: "counter", total: 0 };
    if (entry.kind === "counter") entry.total += by;
    else if (entry.kind === "gauge") entry.value += by;
    else {
      entry.sum += by;
      entry.count += 1;
      entry.last = by;
    }
    this.values.set(key, entry);
  }

  /** Sets a gauge to its latest observation. */
  set(name: MetricName, value: number): void {
    this.values.set(name, { kind: "gauge", value });
  }

  /** Records one observation of a per-settlement metric. */
  observe(name: MetricName, value: number): void {
    const entry = this.values.get(name);
    if (entry === undefined || entry.kind !== "observed") {
      this.values.set(name, { kind: "observed", sum: value, count: 1, last: value });
      return;
    }
    entry.sum += value;
    entry.count += 1;
    entry.last = value;
  }

  /** The mean of an observed metric, a gauge's value, or a counter's total. */
  get(key: string): number {
    const entry = this.values.get(key);
    if (entry === undefined) return 0;
    if (entry.kind === "counter") return entry.total;
    if (entry.kind === "gauge") return entry.value;
    return entry.count === 0 ? 0 : entry.sum / entry.count;
  }

  /** The most recent observation, for what IX-2 attaches to one settlement. */
  last(key: string): number {
    const entry = this.values.get(key);
    if (entry === undefined) return 0;
    return entry.kind === "observed" ? entry.last : this.get(key);
  }

  /** Every metric, by key — the body of IX-2's `MetricsEvent`. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.values.keys()].sort()) out[key] = this.get(key);
    return out;
  }

  /**
   * The A.5 metrics that must be zero and are not (CT-13, EC-4).
   *
   * A non-empty result is the design having failed at something it says cannot
   * happen: value has left the escrow ledger, or the settler left a fillable
   * order out.
   */
  violations(): string[] {
    return ["escrow_invariant_drift_wei", "selection_omitted_total"].filter((name) => this.get(name) !== 0);
  }
}
