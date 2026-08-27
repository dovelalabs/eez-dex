//! The one state store the four tasks share (SV-1).
//!
//! Phase 3 stub — owner implements.
//!
//! What it holds, and why each is state rather than a derivation:
//!
//! * the open window's orders, rebuilt from L2 logs on restart (SV-5);
//! * the L1 head and the target pool's live state (A.5, watcher);
//! * the current settlement attempt. In-flight versus known-dropped is
//!   **explicit state, never inferred from a timer alone** (SV-5): a settlement
//!   the front still holds must never be resubmitted, and one the relay
//!   reported dropped must be resubmitted exactly once;
//! * the per-asset escrow ledger the reconciler checks against CT-13;
//! * the metric values of [`crate::config::metrics`].

use crate::config::Config;

/// The shared state store.
#[derive(Debug)]
pub struct StateStore {
    _phase: (),
}

impl StateStore {
    /// Opens the store and rebuilds window state from L2 logs (SV-5).
    pub fn open(_config: &Config) -> Self {
        unimplemented!("Phase 3")
    }

    /// The id of the window currently open.
    pub fn current_window(&self) -> u64 {
        unimplemented!("Phase 3")
    }
}
