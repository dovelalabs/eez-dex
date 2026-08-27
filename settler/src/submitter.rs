//! Submitter — one settlement per window to the L2->L1 front (SV-3).
//!
//! Phase 3 stub — owner implements.
//!
//! Signed offline, with explicit gas, timed to the slot boundary, with
//! `deadline = sync-block timestamp + DEADLINE_SECONDS`. Never more than one
//! in flight. On a missed L1 slot the Sync block is empty and the window
//! stretches: the settler waits for the next steady slot rather than
//! resubmitting. An empty window submits a CT-6 refresh only when the mirror's
//! age exceeds `MIRROR_REFRESH_AGE`.

use crate::{Config, Task, TaskError, state::StateStore};

/// Posts the settlement transaction.
#[derive(Debug)]
pub struct Submitter {
    _phase: (),
}

impl Submitter {
    /// Builds the submitter from a validated configuration.
    pub fn new(_config: &Config) -> Self {
        unimplemented!("Phase 3")
    }
}

impl Task for Submitter {
    fn name(&self) -> &'static str {
        "submitter"
    }

    fn tick(&mut self, _state: &mut StateStore) -> Result<(), TaskError> {
        unimplemented!("Phase 3")
    }
}
