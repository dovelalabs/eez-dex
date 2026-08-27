//! `eez-dex-settler` — the off-chain half of one window (RD-2 WP-3, SV-1 … SV-5).
//!
//! Four tasks over one state store: **watcher** reads the open window and the
//! L1 head, **builder** crosses, simulates against that head and selects the
//! fillable subset, **submitter** posts exactly one settlement per window to
//! the L2->L1 front, **reconciler** matches the outcome and audits it.
//!
//! Two properties hold everywhere in this crate:
//!
//! * **Determinism.** Selection is a pure function of its inputs; ties and drop
//!   order resolve by ascending order id, so any two settlers with the same
//!   inputs produce the same selection (SV-2). No LLM in the control path.
//! * **The settler is not the last check.** It never holds user funds and its
//!   selection is a suggestion: `WindowBook` rebuilds the leg and the contract
//!   enforces every limit (CT-9, CT-10). What the settler owes is liveness and
//!   fairness, and both are observable on-chain (EC-4).
//!
//! Only [`config`] is frozen at the scaffold. The task framework below is a
//! Phase 3 stub and Phase 3 may reshape it; every body is
//! `unimplemented!("Phase 3")`, which panics with `not implemented: Phase 3`.

#![forbid(unsafe_code)]

pub mod builder;
pub mod config;
pub mod reconciler;
pub mod state;
pub mod submitter;
pub mod watcher;

pub use config::{Config, ConfigError, FeeModel, Profile, RouteFeeModel, WindowSlots};

/// Why a task tick failed. Phase 3 owns the variants; a task that cannot make
/// progress says so rather than guessing.
#[derive(Debug)]
#[non_exhaustive]
pub enum TaskError {
    /// The configuration was rejected at startup.
    Config(ConfigError),
    /// An upstream RPC did not answer, or answered with an error.
    Rpc(String),
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(e) => write!(f, "configuration: {e}"),
            Self::Rpc(e) => write!(f, "rpc: {e}"),
        }
    }
}

impl std::error::Error for TaskError {}

impl From<ConfigError> for TaskError {
    fn from(e: ConfigError) -> Self {
        Self::Config(e)
    }
}

/// One of the four A.5 tasks, driven over the shared state store (SV-1).
///
/// The trait is deliberately product-agnostic so a second product could
/// extract it later; no such extraction is in scope (SV-1).
pub trait Task {
    /// The task's name, as it appears in logs and metric labels.
    fn name(&self) -> &'static str;

    /// Advances the task by one step against the shared state.
    fn tick(&mut self, state: &mut state::StateStore) -> Result<(), TaskError>;
}
