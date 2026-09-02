//! The A.5 metrics, under the frozen names.
//!
//! Every name comes from [`crate::config::metrics`], which is frozen at the
//! scaffold because WP-4's scenario asserts on these strings and WP-5's
//! amortisation stream reads them. Nothing here invents a name; a metric this
//! module could not resolve to a frozen constant would be a metric no consumer
//! is looking for.
//!
//! Two of them are invariants rather than measurements and are called out as
//! such: `escrow_invariant_drift_wei` and `selection_omitted_total` **must be
//! zero** (CT-13, EC-4). [`Metrics::violations`] is what a scenario asserts on.

use std::collections::BTreeMap;

use crate::config::metrics as names;

/// A metric's current value. Counters accumulate; gauges are the last
/// observation; the observed ones carry a running mean so `fills_per_settlement`
/// answers "per settlement" rather than "in the last one".
#[derive(Debug, Clone, Copy, PartialEq)]
enum Value {
    Counter(f64),
    Gauge(f64),
    Observed { sum: f64, count: u64, last: f64 },
}

impl Value {
    fn as_f64(self) -> f64 {
        match self {
            Self::Counter(value) | Self::Gauge(value) => value,
            Self::Observed { sum, count, .. } => {
                if count == 0 {
                    0.0
                } else {
                    sum / count as f64
                }
            }
        }
    }
}

/// The settler's metric registry (A.5).
///
/// Keys are `name` for an unlabelled metric and `name{label="value"}` for a
/// labelled one — the only labelled metric is `windows_total{outcome=...}`.
#[derive(Debug, Clone, Default)]
pub struct Metrics {
    values: BTreeMap<String, Value>,
}

impl Metrics {
    /// An empty registry with every A.5 metric present at zero.
    ///
    /// Present-at-zero matters: a consumer that cannot distinguish "no windows
    /// have settled" from "this settler does not publish that metric" cannot
    /// tell a quiet chain from a broken one (FE-10).
    pub fn new() -> Self {
        let mut metrics = Self::default();
        for outcome in names::WINDOW_OUTCOMES {
            metrics
                .values
                .insert(window_outcome_key(outcome), Value::Counter(0.0));
        }
        for name in names::ALL {
            if name == names::WINDOWS_TOTAL {
                continue;
            }
            let value = match name {
                names::SELECTION_OMITTED_TOTAL => Value::Counter(0.0),
                names::FILLS_PER_SETTLEMENT
                | names::GAS_PER_FILL_WEI
                | names::COUNTERFACTUAL_L1_GAS_WEI
                | names::TIME_TO_SETTLE_SECONDS
                | names::IMPACT_BPS
                | names::NETTING_RATIO => Value::Observed {
                    sum: 0.0,
                    count: 0,
                    last: 0.0,
                },
                _ => Value::Gauge(0.0),
            };
            metrics.values.insert(name.to_string(), value);
        }
        metrics
    }

    /// Counts one window under its A.4 outcome — `windows_total{outcome=...}`.
    pub fn record_window(&mut self, outcome: &str) {
        debug_assert!(
            names::WINDOW_OUTCOMES.contains(&outcome),
            "windows_total's outcome label is frozen (A.5)"
        );
        self.add(&window_outcome_key(outcome), 1.0);
    }

    /// Adds to a counter.
    pub fn increment(&mut self, name: &str, by: f64) {
        self.add(name, by);
    }

    /// Sets a gauge to its latest observation.
    pub fn set(&mut self, name: &str, value: f64) {
        self.values.insert(name.to_string(), Value::Gauge(value));
    }

    /// Records one observation of a per-settlement metric.
    pub fn observe(&mut self, name: &str, value: f64) {
        let entry = self
            .values
            .entry(name.to_string())
            .or_insert(Value::Observed {
                sum: 0.0,
                count: 0,
                last: 0.0,
            });
        if let Value::Observed { sum, count, last } = entry {
            *sum += value;
            *count += 1;
            *last = value;
        } else {
            *entry = Value::Observed {
                sum: value,
                count: 1,
                last: value,
            };
        }
    }

    /// The mean of an observed metric, the value of a gauge, or a counter's
    /// total — what [`Metrics::snapshot`] publishes.
    pub fn get(&self, name: &str) -> f64 {
        self.values.get(name).copied().map_or(0.0, Value::as_f64)
    }

    /// The most recent observation of a per-settlement metric, for the values
    /// IX-2 attaches to one settlement rather than to the run.
    pub fn last(&self, name: &str) -> f64 {
        match self.values.get(name) {
            Some(Value::Observed { last, .. }) => *last,
            other => other.copied().map_or(0.0, Value::as_f64),
        }
    }

    /// One window's outcome count.
    pub fn window_count(&self, outcome: &str) -> f64 {
        self.get(&window_outcome_key(outcome))
    }

    /// Every metric, by key — the body of IX-2's `MetricsEvent`.
    pub fn snapshot(&self) -> BTreeMap<String, f64> {
        self.values
            .iter()
            .map(|(name, value)| (name.clone(), value.as_f64()))
            .collect()
    }

    /// The A.5 metrics that must be zero and are not (CT-13, EC-4).
    ///
    /// A non-empty result is the settler having failed at something the whole
    /// design says cannot happen: value has left the escrow ledger, or the
    /// settler left a fillable order out. Both are on-chain-observable, which
    /// is exactly why they are metrics and not assertions (EC-4).
    pub fn violations(&self) -> Vec<&'static str> {
        [
            names::ESCROW_INVARIANT_DRIFT_WEI,
            names::SELECTION_OMITTED_TOTAL,
        ]
        .into_iter()
        .filter(|name| self.get(name) != 0.0)
        .collect()
    }

    fn add(&mut self, name: &str, by: f64) {
        let entry = self
            .values
            .entry(name.to_string())
            .or_insert(Value::Counter(0.0));
        match entry {
            Value::Counter(value) | Value::Gauge(value) => *value += by,
            Value::Observed { sum, count, last } => {
                *sum += by;
                *count += 1;
                *last = by;
            }
        }
    }
}

/// `windows_total{outcome="..."}`.
fn window_outcome_key(outcome: &str) -> String {
    format!("{}{{outcome=\"{outcome}\"}}", names::WINDOWS_TOTAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a5_every_frozen_metric_is_published_from_the_first_tick() {
        let metrics = Metrics::new();
        let snapshot = metrics.snapshot();

        for name in names::ALL {
            if name == names::WINDOWS_TOTAL {
                for outcome in names::WINDOW_OUTCOMES {
                    assert!(
                        snapshot.contains_key(&window_outcome_key(outcome)),
                        "{name}{{outcome={outcome}}} must be published"
                    );
                }
                continue;
            }
            assert!(snapshot.contains_key(name), "{name} must be published");
        }
        assert_eq!(
            snapshot.len(),
            names::ALL.len() - 1 + names::WINDOW_OUTCOMES.len(),
            "nothing published that A.5 does not name"
        );
    }

    #[test]
    fn a5_windows_total_counts_by_the_a4_outcome() {
        let mut metrics = Metrics::new();
        metrics.record_window("settled");
        metrics.record_window("settled");
        metrics.record_window("evicted");
        assert_eq!(metrics.window_count("settled"), 2.0);
        assert_eq!(metrics.window_count("evicted"), 1.0);
        assert_eq!(metrics.window_count("rolled_back"), 0.0);
        assert_eq!(metrics.window_count("empty"), 0.0);
    }

    #[test]
    fn a5_per_settlement_metrics_report_a_mean_and_keep_the_last() {
        let mut metrics = Metrics::new();
        metrics.observe(names::FILLS_PER_SETTLEMENT, 8.0);
        metrics.observe(names::FILLS_PER_SETTLEMENT, 4.0);
        assert_eq!(metrics.get(names::FILLS_PER_SETTLEMENT), 6.0, "the mean");
        assert_eq!(metrics.last(names::FILLS_PER_SETTLEMENT), 4.0, "the latest");
    }

    #[test]
    fn a5_gauges_hold_the_latest_observation() {
        let mut metrics = Metrics::new();
        metrics.set(names::MIRROR_AGE_SLOTS, 3.0);
        metrics.set(names::MIRROR_AGE_SLOTS, 0.0);
        assert_eq!(metrics.get(names::MIRROR_AGE_SLOTS), 0.0);
        metrics.set(names::WINDOW_SLOTS, 2.0);
        assert_eq!(metrics.get(names::WINDOW_SLOTS), 2.0);
    }

    #[test]
    fn ct13_and_ec4_the_two_metrics_that_must_be_zero_are_reported_as_violations() {
        let mut metrics = Metrics::new();
        assert!(
            metrics.violations().is_empty(),
            "a healthy settler has none"
        );

        metrics.increment(names::SELECTION_OMITTED_TOTAL, 1.0);
        assert_eq!(metrics.violations(), vec![names::SELECTION_OMITTED_TOTAL]);

        metrics.set(names::ESCROW_INVARIANT_DRIFT_WEI, -7.0);
        assert_eq!(
            metrics.violations(),
            vec![
                names::ESCROW_INVARIANT_DRIFT_WEI,
                names::SELECTION_OMITTED_TOTAL
            ],
            "drift in either direction is a violation"
        );
    }

    #[test]
    fn a5_an_unknown_metric_reads_as_zero_rather_than_panicking() {
        let metrics = Metrics::new();
        assert_eq!(metrics.get("not_a_metric"), 0.0);
        assert_eq!(metrics.last("not_a_metric"), 0.0);
    }
}
