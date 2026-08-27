//! The settler binary.
//!
//! Phase 3 stub — owner implements. The configuration is real and parsed here
//! so a misconfigured deployment fails at startup rather than at the first
//! slot boundary; everything past it is Phase 3's.

use eez_dex_settler::{Config, builder::WindowBuilder, reconciler::Reconciler, state::StateStore};
use eez_dex_settler::{submitter::Submitter, watcher::Watcher};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    eprintln!(
        "eez-dex-settler: {:?} profile, window_slots={}",
        config.profile(),
        config.window_slots.as_u8()
    );

    let state = StateStore::open(&config);
    let _tasks: Vec<Box<dyn eez_dex_settler::Task>> = vec![
        Box::new(Watcher::new(&config)),
        Box::new(WindowBuilder::new(&config)),
        Box::new(Submitter::new(&config)),
        Box::new(Reconciler::new(&config)),
    ];
    let _ = state.current_window();

    unimplemented!("Phase 3")
}
