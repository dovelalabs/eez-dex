//! Phase 3 is implemented: nothing in this crate is a stub any more.
//!
//! The scaffold left every Phase 3 entry point as `unimplemented!("Phase 3")`
//! and pinned that here, so a phase that landed a partial implementation broke
//! its own row and no other phase's. This file is the other end of that
//! contract: the four A.5 tasks answer, the state store they share answers,
//! and the frozen configuration is still frozen and still real.
//!
//! The indexer, frontend and scenario stubs are other phases' to retire.

use std::collections::HashMap;

use eez_dex_settler::attempt::Attempt;
use eez_dex_settler::builder::WindowBuilder;
use eez_dex_settler::config::{Config, metrics};
use eez_dex_settler::reconciler::Reconciler;
use eez_dex_settler::state::StateStore;
use eez_dex_settler::submitter::Submitter;
use eez_dex_settler::testkit::{FakeFront, FakeL1, FakeL2, FakeSigner};
use eez_dex_settler::watcher::Watcher;
use eez_dex_settler::{Task, TaskError};

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

/// SV-1: four tasks over one state store, and every one of them answers.
#[test]
fn sv1_the_four_tasks_are_implemented_not_stubbed() {
    let config = config();
    let l2 = FakeL2::new();
    let l1 = FakeL1::at(2000);
    let front = FakeFront::new();

    let tasks: Vec<Box<dyn Task>> = vec![
        Box::new(Watcher::new(l2.clone(), l1.clone(), 0)),
        Box::new(WindowBuilder::new(&config, l1.simulator())),
        Box::new(Submitter::new(
            &config,
            l2.clone(),
            front.clone(),
            FakeSigner,
        )),
        Box::new(Reconciler::new(&config, l2, l1, front)),
    ];
    assert_eq!(
        tasks.iter().map(|task| task.name()).collect::<Vec<_>>(),
        ["watcher", "builder", "submitter", "reconciler"],
        "A.5's four tasks, under A.5's names"
    );
}

/// SV-1's state store is real, and it opens empty: window state is rebuilt
/// from L2 logs, so a restart and a cold start take the same path (SV-5).
#[test]
fn sv1_the_shared_state_store_is_implemented() {
    let store = StateStore::open(&config());
    assert_eq!(store.current_window(), 0);
    assert!(store.open_orders().is_empty());
    assert!(!store.halted);
    assert_eq!(store.attempt, Attempt::idle(0));
}

/// A task that cannot make progress says so rather than guessing (SV-2): the
/// watcher over a book it cannot read is an error, not an empty window.
#[test]
fn sv1_a_task_that_cannot_read_its_chain_reports_it() {
    let mut store = StateStore::open(&config());
    // A fake book with no window set answers no window.
    let error = Watcher::new(FakeL2::new(), FakeL1::at(2000), 0)
        .tick(&mut store)
        .unwrap_err();
    assert!(matches!(error, TaskError::Rpc(_)));
    assert!(store.open_orders().is_empty());
}

/// The configuration is frozen and real, so a misconfigured deployment fails
/// at startup rather than at the first slot boundary.
#[test]
fn a5_configuration_is_implemented_not_stubbed() {
    let config = config();
    assert_eq!(config.deadline_seconds, 24);
    assert_eq!(metrics::ALL.len(), 13);
}

/// Every A.5 metric is published from the first tick, under the frozen names
/// WP-4's scenario asserts on.
#[test]
fn a5_every_metric_is_published_under_its_frozen_name() {
    let store = StateStore::open(&config());
    let snapshot = store.metrics.snapshot();
    for name in metrics::ALL {
        if name == metrics::WINDOWS_TOTAL {
            for outcome in metrics::WINDOW_OUTCOMES {
                assert!(
                    snapshot.contains_key(&format!("{name}{{outcome=\"{outcome}\"}}")),
                    "{name} must be published for every outcome"
                );
            }
            continue;
        }
        assert!(snapshot.contains_key(name), "{name} must be published");
    }
    assert!(
        store.metrics.violations().is_empty(),
        "a settler that has done nothing has violated nothing"
    );
}
