//! Every Phase 3 entry point exists, compiles, and fails loudly naming its
//! owner. `unimplemented!("Phase 3")` panics with `not implemented: Phase 3`,
//! and this pins that: a phase that lands a partial implementation breaks its
//! own row here and no other phase's.

use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};

use eez_dex_settler::builder::WindowBuilder;
use eez_dex_settler::config::{Config, metrics};
use eez_dex_settler::reconciler::Reconciler;
use eez_dex_settler::state::StateStore;
use eez_dex_settler::submitter::Submitter;
use eez_dex_settler::watcher::Watcher;

fn config() -> Config {
    let map: HashMap<String, String> = [
        ("L1_RPC", "https://eth.drpc.org"),
        ("L2_RPC", "http://127.0.0.1:8545"),
        ("L2_FRONT", "http://127.0.0.1:8547"),
        ("WINDOW_BOOK", "0x00000000000000000000000000000000000000b0"),
        ("ROUTER", "0x00000000000000000000000000000000000000a1"),
        ("POOL", "0x00000000000000000000000000000000000000c2"),
        (
            "SETTLER_KEY",
            "0x1111111111111111111111111111111111111111111111111111111111111111",
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    Config::from_map(&map).expect("the scaffold's fixture config parses")
}

/// Runs `f` and returns the panic message it produced.
fn panic_message(f: impl FnOnce()) -> String {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let payload = panic::catch_unwind(AssertUnwindSafe(f)).expect_err("a stub must panic");
    panic::set_hook(previous);

    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .expect("a panic message")
}

#[test]
fn phase3_task_constructors_are_stubs() {
    let config = config();
    for message in [
        panic_message(|| {
            Watcher::new(&config);
        }),
        panic_message(|| {
            WindowBuilder::new(&config);
        }),
        panic_message(|| {
            Submitter::new(&config);
        }),
        panic_message(|| {
            Reconciler::new(&config);
        }),
        panic_message(|| {
            StateStore::open(&config);
        }),
    ] {
        assert_eq!(message, "not implemented: Phase 3");
    }
}

/// The configuration is not a stub: it is frozen and real, so a misconfigured
/// deployment fails at startup rather than at the first slot boundary.
#[test]
fn a5_configuration_is_implemented_not_stubbed() {
    let config = config();
    assert_eq!(config.deadline_seconds, 24);
    assert_eq!(metrics::ALL.len(), 13);
}
