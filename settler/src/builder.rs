//! Window builder — cross, residual, simulation, selection (SV-2, FL-8).
//!
//! Phase 3 stub — owner implements.
//!
//! At the slot boundary: read the open orders, compute the cross and the
//! residual, simulate `SettlementRouter.settle` against the L1 head with
//! `eth_call`, derive the clearing price, then drop limit-violating orders and
//! re-simulate until stable. Iteration is bounded by the number of orders;
//! ties and drop order resolve by ascending order id. The result is
//! **inclusion-maximal**: no dropped order could be re-added without violating
//! a limit.
//!
//! The output is a suggestion. `WindowBook.settleWindow` rebuilds the leg from
//! the still-open subset and the contract enforces every limit (CT-9, CT-10).

use crate::{Config, Task, TaskError, state::StateStore};

/// Selects the fillable subset for the window about to close.
#[derive(Debug)]
pub struct WindowBuilder {
    _phase: (),
}

impl WindowBuilder {
    /// Builds the window builder from a validated configuration.
    pub fn new(_config: &Config) -> Self {
        unimplemented!("Phase 3")
    }

    /// The inclusion-maximal selection for `state`'s open window, as order ids
    /// in ascending order.
    ///
    /// Pure: identical inputs produce an identical selection on any settler
    /// (SV-2), which is what makes TS-3's permutation property testable.
    pub fn select(&self, _state: &StateStore) -> Vec<[u8; 32]> {
        unimplemented!("Phase 3")
    }
}

impl Task for WindowBuilder {
    fn name(&self) -> &'static str {
        "builder"
    }

    fn tick(&mut self, _state: &mut StateStore) -> Result<(), TaskError> {
        unimplemented!("Phase 3")
    }
}
