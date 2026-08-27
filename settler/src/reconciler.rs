//! Reconciler — outcome, audit, invariant, halt (SV-4, EC-4).
//!
//! Phase 3 stub — owner implements.
//!
//! Matches `WindowSettled` to the L1 receipt, reading L2 at `safe` for
//! operations and `finalized` for accounting. Distinguishes the three failure
//! shapes that look alike from L2: poison eviction (free), rollback (bundle
//! missed or reorged), and the `postBatch` **skip** case, where the L1 entry
//! reverted at inclusion and L1 gas *was* spent. Re-forms the window on
//! failure, checks the per-asset escrow invariant (CT-13), and halts on the
//! unposted-window threshold.
//!
//! It also audits the settler that produced the selection: recomputing the
//! inclusion-maximal set from the settled `P0` and reporting any fillable
//! order that was left out as `selection_omitted_total` (EC-4, TS-3).

use crate::{Config, Task, TaskError, state::StateStore};

/// Matches settlements to their outcome and audits the selection.
#[derive(Debug)]
pub struct Reconciler {
    _phase: (),
}

impl Reconciler {
    /// Builds the reconciler from a validated configuration.
    pub fn new(_config: &Config) -> Self {
        unimplemented!("Phase 3")
    }

    /// Fillable orders the settler omitted from the settled window — the
    /// `selection_omitted_total` metric, which must be zero (EC-4).
    pub fn audit_selection(&self, _state: &StateStore) -> Vec<[u8; 32]> {
        unimplemented!("Phase 3")
    }
}

impl Task for Reconciler {
    fn name(&self) -> &'static str {
        "reconciler"
    }

    fn tick(&mut self, _state: &mut StateStore) -> Result<(), TaskError> {
        unimplemented!("Phase 3")
    }
}
