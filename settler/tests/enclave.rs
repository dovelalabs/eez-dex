//! TS-3's integration suites, against a running enclave.
//!
//! Gated behind the `enclave` feature so `make check` stays offline and fast.
//! See `settler/README.md` for how to bring one up and run them.
//!
//! These are the same two properties `tests/service.rs` pins in process —
//! **restart mid-window** and **known-dropped resubmission** — asserted against
//! a real `WindowBook`, a real L2->L1 front and a real relay, where the timing
//! is the framework's rather than the test's. The in-process suite proves the
//! logic; this one proves the settler reads the real thing correctly.
//!
//! Every endpoint comes from the A.5 configuration, so the settler under test
//! is configured exactly as it is deployed. A missing key fails the test with
//! the key's name rather than skipping quietly: the feature is opt-in, and a
//! suite that silently passed without an enclave would be worse than no suite.

#![cfg(feature = "enclave")]

use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use alloy_primitives::Address;
use eez_dex_settler::builder::WindowBuilder;
use eez_dex_settler::chain::{
    Front, FrontRpc, L1Rpc, L2Reader, L2Rpc, LocalSettlementSigner, RpcClient, SettlementSigner,
};
use eez_dex_settler::config::metrics as names;
use eez_dex_settler::reconciler::Reconciler;
use eez_dex_settler::state::StateStore;
use eez_dex_settler::submitter::Submitter;
use eez_dex_settler::watcher::Watcher;
use eez_dex_settler::{Config, Task};

/// How long a test waits for a window to reach the Sync block. Two L1 slots
/// plus the framework's own slack; a window that has not settled by then has
/// stretched for a reason the test should report rather than wait out.
const WINDOW_TIMEOUT: Duration = Duration::from_secs(90);

/// One L2 block.
const TICK: Duration = Duration::from_secs(2);

/// The enclave's configuration, or a failure naming what is missing.
fn config() -> Config {
    Config::from_env().unwrap_or_else(|error| {
        panic!(
            "the enclave suite needs the A.5 configuration in the environment \
             ({error}). Bring an enclave up and export L1_RPC, L2_RPC, \
             L2_FRONT, WINDOW_BOOK, ROUTER, POOL and SETTLER_KEY — see \
             settler/README.md."
        )
    })
}

/// Everything one settler needs, wired as `main` wires it.
struct Harness {
    config: Config,
    l2: L2Rpc,
    l1: L1Rpc,
    front: FrontRpc,
    signer: LocalSettlementSigner,
    settler: Address,
}

impl Harness {
    fn new() -> Self {
        let config = config();
        let runtime = Arc::new(tokio::runtime::Runtime::new().expect("a tokio runtime"));
        let book: Address = config.window_book.parse().expect("WINDOW_BOOK");
        let router: Address = config.router.parse().expect("ROUTER");
        let pool: Address = config.pool.parse().expect("POOL");

        let l1 = L1Rpc::new(
            RpcClient::connect(runtime.clone(), &config.l1_rpc).expect("L1_RPC"),
            router,
            pool,
            pool,
            router,
        );
        let l2 = L2Rpc::new(
            RpcClient::connect(runtime.clone(), &config.l2_rpc).expect("L2_RPC"),
            book,
        );
        let front = FrontRpc::new(RpcClient::connect(runtime, &config.l2_front).expect("L2_FRONT"));
        let signer = LocalSettlementSigner::new(&config.settler_key, book).expect("SETTLER_KEY");
        let settler = signer.address();

        Self {
            config,
            l2,
            l1,
            front,
            signer,
            settler,
        }
    }

    /// The four tasks, over a fresh store — a settler that has just started.
    fn tasks(&self) -> Vec<Box<dyn Task>> {
        vec![
            Box::new(Watcher::new(self.l2.clone(), self.l1.clone(), 0)),
            Box::new(WindowBuilder::new(&self.config, self.l1.clone())),
            Box::new(Submitter::new(
                &self.config,
                self.l2.clone(),
                self.front.clone(),
                self.signer.clone(),
            )),
            Box::new(Reconciler::new(
                &self.config,
                self.l2.clone(),
                self.l1.clone(),
                self.front.clone(),
            )),
        ]
    }

    /// Steps every task once, reporting rather than swallowing a failure.
    fn step(&self, tasks: &mut [Box<dyn Task>], state: &mut StateStore) {
        for task in tasks.iter_mut() {
            if let Err(error) = task.tick(state) {
                eprintln!("{} failed: {error}", task.name());
            }
        }
    }

    /// The settler key's nonce on L2 — how many settlements it has landed.
    fn settlements_landed(&self) -> u64 {
        self.l2.nonce(self.settler).expect("the settler's nonce")
    }
}

/// SV-5 / TS-3: stop and start the settler between selection and submission.
/// Exactly one settlement for the window; no duplicate.
#[test]
fn restart_mid_window() {
    let harness = Harness::new();
    let before = harness.settlements_landed();

    // Run until a settlement is in flight, then throw the process away.
    let mut state = StateStore::open(&harness.config);
    let mut tasks = harness.tasks();
    let deadline = Instant::now() + WINDOW_TIMEOUT;
    while state.attempt.tx_hash().is_none() {
        assert!(
            Instant::now() < deadline,
            "no settlement was submitted within {WINDOW_TIMEOUT:?}; is the \
             scenario placing orders?"
        );
        harness.step(&mut tasks, &mut state);
        sleep(TICK);
    }
    let in_flight = state.attempt.tx_hash().expect("a settlement in flight");

    // The restart: a new store and new tasks, with no memory of the attempt.
    // The front still holds it, and that is what must stop a second one.
    drop(tasks);
    drop(state);
    let mut restarted_state = StateStore::open(&harness.config);
    let mut restarted = harness.tasks();
    let deadline = Instant::now() + WINDOW_TIMEOUT;
    while Instant::now() < deadline {
        harness.step(&mut restarted, &mut restarted_state);
        assert!(
            harness.settlements_landed() <= before + 1,
            "the restarted settler submitted a second settlement for one \
             window; {in_flight:#x} was still in flight"
        );
        if harness.settlements_landed() == before + 1
            && !harness
                .front
                .holds_from(harness.settler)
                .expect("the front answers")
        {
            break;
        }
        sleep(TICK);
    }

    assert_eq!(
        harness.settlements_landed(),
        before + 1,
        "exactly one settlement for the window, across the restart (SV-5)"
    );
    assert_eq!(
        restarted_state
            .metrics
            .get(names::ESCROW_INVARIANT_DRIFT_WEI),
        0.0,
        "CT-13 holds after the restart"
    );
}

/// SV-5 / TS-3: a settlement the relay reports dropped is known dropped, and
/// the window is re-formed and resubmitted **once**.
#[test]
fn known_dropped_resubmission() {
    let harness = Harness::new();
    let mut state = StateStore::open(&harness.config);
    let mut tasks = harness.tasks();

    let deadline = Instant::now() + WINDOW_TIMEOUT;
    while state.attempt.tx_hash().is_none() {
        assert!(
            Instant::now() < deadline,
            "no settlement was submitted within {WINDOW_TIMEOUT:?}"
        );
        harness.step(&mut tasks, &mut state);
        sleep(TICK);
    }
    let first = state.attempt.tx_hash().expect("a settlement in flight");

    // Wait for the relay to either land it or drop it. Both are outcomes the
    // settler must reach on evidence; neither is a timeout.
    let deadline = Instant::now() + WINDOW_TIMEOUT;
    while Instant::now() < deadline
        && !state.attempt.owes_resubmission()
        && !state.attempt.is_resolved()
    {
        harness.step(&mut tasks, &mut state);
        sleep(TICK);
    }

    if state.attempt.is_resolved() {
        // The relay landed it; there was nothing to resubmit. That is a pass
        // for SV-3 and this suite has nothing further to say — the drop path
        // is exercised by the failure matrix (HX-3), which can induce one.
        eprintln!("the settlement landed; no drop to resubmit");
        return;
    }

    assert!(
        state.attempt.owes_resubmission(),
        "three consecutive relay drops must evict {first:#x} (SV-5)"
    );

    harness.step(&mut tasks, &mut state);
    let second = state.attempt.tx_hash().expect("the one resubmission");
    assert_ne!(second, first, "the resubmission is a fresh transaction");

    // And there is never a third.
    for _ in 0..10 {
        harness.step(&mut tasks, &mut state);
        sleep(TICK);
        if let Some(current) = state.attempt.tx_hash() {
            assert!(
                current == second || state.attempt.is_resolved(),
                "one resubmission, not a retry loop (SV-5)"
            );
        }
    }
}
