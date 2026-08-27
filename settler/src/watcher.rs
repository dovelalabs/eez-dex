//! Watcher — the open window's orders, the L1 head, the pool's live state (A.5).
//!
//! Phase 3 stub — owner implements.

use crate::{Config, Task, TaskError, state::StateStore};

/// Tracks `WindowBook` logs on L2 and the target pool on L1.
#[derive(Debug)]
pub struct Watcher {
    _phase: (),
}

impl Watcher {
    /// Builds the watcher from a validated configuration.
    pub fn new(_config: &Config) -> Self {
        unimplemented!("Phase 3")
    }
}

impl Task for Watcher {
    fn name(&self) -> &'static str {
        "watcher"
    }

    fn tick(&mut self, _state: &mut StateStore) -> Result<(), TaskError> {
        unimplemented!("Phase 3")
    }
}
