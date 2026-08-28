//! The whole settler, driven end to end (SV-1 … SV-5, TS-3).
//!
//! Four tasks over one state store, stepped in order the way the binary steps
//! them, against the fake chains of [`eez_dex_settler::testkit`]. These are the
//! in-process halves of TS-3's integration suites: the same two properties the
//! enclave tests assert — **restart mid-window** and **known-dropped
//! resubmission** — verified here on every `make check`, and again against a
//! real enclave under `--features enclave` (see `tests/enclave.rs`).
//!
//! What they pin is the property the whole design turns on: **exactly one
//! settlement per window, whatever happens to the settler.**

use alloy_primitives::B256;
use eez_dex_settler::builder::WindowBuilder;
use eez_dex_settler::chain::{FrontStatus, L1Receipt};
use eez_dex_settler::config::metrics as names;
use eez_dex_settler::reconciler::Reconciler;
use eez_dex_settler::state::{OrderPhase, StateStore, WindowPhase};
use eez_dex_settler::submitter::Submitter;
use eez_dex_settler::testkit::{
    FakeFront, FakeL1, FakeL2, FakeSigner, fixture_config, fixture_mirror, order, store,
};
use eez_dex_settler::types::{Order, Side};
use eez_dex_settler::watcher::Watcher;
use eez_dex_settler::{Task, chain::BookEvent};

/// A.6's happy path: eight accounts, a mix of buys and sells, limits at the
/// mirror price plus or minus a tolerance.
fn eight_orders() -> Vec<Order> {
    vec![
        order(
            1,
            Side::SellAForB,
            "5000000000000000000",
            "9000000000000000000000",
        ),
        order(
            2,
            Side::SellAForB,
            "4000000000000000000",
            "7400000000000000000000",
        ),
        order(
            3,
            Side::SellAForB,
            "3000000000000000000",
            "5700000000000000000000",
        ),
        order(
            4,
            Side::SellAForB,
            "2000000000000000000",
            "3900000000000000000000",
        ),
        order(
            5,
            Side::SellBForA,
            "6000000000000000000000",
            "2800000000000000000",
        ),
        order(
            6,
            Side::SellBForA,
            "4000000000000000000000",
            "1900000000000000000",
        ),
        order(
            7,
            Side::SellBForA,
            "3000000000000000000000",
            "1450000000000000000",
        ),
        order(
            8,
            Side::SellBForA,
            "2000000000000000000000",
            "990000000000000000",
        ),
    ]
}

/// One settler: the four tasks and the chains they read.
struct Settler {
    l2: FakeL2,
    l1: FakeL1,
    front: FakeFront,
    tasks: Vec<Box<dyn Task>>,
}

impl Settler {
    /// A settler over `l2`/`l1`/`front`, as `main` wires it (SV-1).
    fn new(l2: &FakeL2, l1: &FakeL1, front: &FakeFront) -> Self {
        let config = fixture_config();
        Self {
            l2: l2.clone(),
            l1: l1.clone(),
            front: front.clone(),
            tasks: vec![
                Box::new(Watcher::new(l2.clone(), l1.clone(), 0)),
                Box::new(WindowBuilder::new(&config, l1.clone())),
                Box::new(Submitter::new(
                    &config,
                    l2.clone(),
                    front.clone(),
                    FakeSigner,
                )),
                Box::new(Reconciler::new(
                    &config,
                    l2.clone(),
                    l1.clone(),
                    front.clone(),
                )),
            ],
        }
    }

    /// One L2 block: every task, in order.
    fn tick(&mut self, state: &mut StateStore) {
        for task in &mut self.tasks {
            task.tick(state).unwrap_or_else(|error| {
                panic!("{} failed: {error}", task.name());
            });
        }
    }

    /// The chains, for a test that needs to move them.
    fn chains(&self) -> (FakeL2, FakeL1, FakeFront) {
        (self.l2.clone(), self.l1.clone(), self.front.clone())
    }
}

/// A book at the Sync block with `orders` open and a 2000 B-per-A head.
fn chains(orders: Vec<Order>) -> (FakeL2, FakeL1, FakeFront) {
    let l2 = FakeL2::new();
    l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
    l2.set_open_orders(orders);
    l2.set_safe_block(6);
    (l2, FakeL1::at(2000), FakeFront::new())
}

/// Puts the canonical `WindowSettled` and its L1 receipt in place, as the
/// framework would once the bundle lands.
fn land_the_bundle(state: &mut StateStore, l2: &FakeL2, l1: &FakeL1, front: &FakeFront) {
    let tx_hash = state.attempt.tx_hash().expect("a settlement in flight");
    let result = state
        .selection
        .as_ref()
        .and_then(|selection| selection.evaluation.as_ref())
        .expect("a settleable selection")
        .result;

    state.observed_settlements.push(BookEvent::Settled {
        window_id: state.window.id,
        result,
        tx_hash,
        l2_block: 6,
        unix: 1_800_000_012,
    });
    front.set_status(tx_hash, FrontStatus::Included { l2_block: 6 });
    l2.set_canonical(tx_hash, true);
    l1.set_entry_receipt(
        result.l1_block,
        L1Receipt {
            tx_hash: B256::repeat_byte(0xf1),
            block_number: result.l1_block,
            gas_used: 240_000,
            effective_gas_price_wei: 1_000_000_000,
            gas_cost_wei: 240_000 * 1_000_000_000,
            success: true,
        },
    );
}

#[test]
fn hx2_eight_orders_settle_in_exactly_one_cross_layer_transaction() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();

    settler.tick(&mut state);
    assert_eq!(front.submitted().len(), 1, "one cross-layer transaction");
    assert_eq!(state.attempt.selection().len(), 8);

    land_the_bundle(&mut state, &l2, &l1, &front);
    settler.tick(&mut state);

    assert_eq!(state.window.phase, WindowPhase::Settled);
    assert_eq!(state.metrics.get(names::FILLS_PER_SETTLEMENT), 8.0);
    assert!(
        state.metrics.get(names::GAS_PER_FILL_WEI)
            < state.metrics.get(names::COUNTERFACTUAL_L1_GAS_WEI),
        "amortisation is real: one L1 transaction beats eight"
    );
    assert!(
        state.metrics.violations().is_empty(),
        "escrow drift and omitted selection are both zero"
    );
    assert_eq!(front.submitted().len(), 1, "and still exactly one");
}

#[test]
fn restart_mid_window_settles_exactly_once() {
    // SV-5 / TS-3: stop and start the settler between selection and the
    // settlement landing. Exactly one settlement for the window; no duplicate.
    let (l2, l1, front) = chains(eight_orders());
    let mut state = store();
    Settler::new(&l2, &l1, &front).tick(&mut state);

    let tx_hash = state.attempt.tx_hash().expect("one settlement in flight");
    assert_eq!(front.submitted().len(), 1);

    // The process dies. Everything in memory goes with it — the attempt
    // included. What survives is the chains and the front.
    let mut restarted_state = store();
    let mut restarted = Settler::new(&l2, &l1, &front);
    for _ in 0..5 {
        restarted.tick(&mut restarted_state);
    }

    assert_eq!(
        front.submitted(),
        vec![tx_hash],
        "the front still holds it, so it is never resubmitted (SV-5)"
    );

    // And when the bundle lands, the restarted settler reconciles it rather
    // than settling the window again.
    restarted_state
        .observed_settlements
        .push(BookEvent::Settled {
            window_id: 0,
            result: state
                .selection
                .as_ref()
                .unwrap()
                .evaluation
                .as_ref()
                .unwrap()
                .result,
            tx_hash,
            l2_block: 6,
            unix: 1_800_000_012,
        });
    // The restarted settler never signed this transaction, so it has no
    // attempt to reconcile until it recovers one; what it must not do is sign
    // a second.
    restarted.tick(&mut restarted_state);
    assert_eq!(front.submitted(), vec![tx_hash], "still exactly one");
}

#[test]
fn known_dropped_resubmission_happens_exactly_once() {
    // SV-5 / TS-3: a settlement the relay reports dropped three times running
    // is known dropped; the window re-forms and resubmits **once**.
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();

    settler.tick(&mut state);
    let first = state.attempt.tx_hash().unwrap();
    assert_eq!(front.submitted().len(), 1);

    // One drop is a pinned slot skipped, not poison.
    front.set_status(first, FrontStatus::Dropped);
    settler.tick(&mut state);
    assert!(state.attempt.is_in_flight(), "one drop is not eviction");
    assert_eq!(front.submitted().len(), 1);

    // Three in a row evict it, and the front stops holding it.
    settler.tick(&mut state);
    settler.tick(&mut state);
    front.set_holds_from_settler(false);
    l2.set_nonce(1);
    assert!(
        state.attempt.owes_resubmission(),
        "three consecutive drops evict (SV-5)"
    );

    settler.tick(&mut state);
    assert_eq!(front.submitted().len(), 2, "re-formed and resubmitted once");
    assert_ne!(front.submitted()[1], first, "a fresh nonce, a fresh hash");

    // The resubmission is dropped too. There is no third attempt, ever.
    let second = front.submitted()[1];
    front.set_status(second, FrontStatus::Dropped);
    front.set_holds_from_settler(false);
    for _ in 0..10 {
        settler.tick(&mut state);
    }
    assert_eq!(
        front.submitted().len(),
        2,
        "one resubmission, not a retry loop"
    );
}

#[test]
fn sv3_a_missed_l1_slot_stretches_the_window_and_settles_in_the_next_steady_slot() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();
    settler.tick(&mut state);
    let tx_hash = state.attempt.tx_hash().unwrap();

    // The Sync block was empty; the window stretches. The front still holds it.
    for _ in 0..3 {
        state.attempt.note_missed_slot();
        settler.tick(&mut state);
    }
    assert_eq!(front.submitted(), vec![tx_hash], "no resubmission");
    assert!(state.attempt.is_in_flight());

    // The next steady slot carries it.
    land_the_bundle(&mut state, &l2, &l1, &front);
    settler.tick(&mut state);
    assert_eq!(state.window.phase, WindowPhase::Settled);
    assert_eq!(front.submitted().len(), 1);
}

#[test]
fn fl7_a_poison_evicted_window_costs_nothing_and_keeps_every_order_open() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();
    settler.tick(&mut state);
    let selected = state.attempt.selection().to_vec();

    // It never reached L1 and the deadline has passed.
    front.set_default_status(FrontStatus::Dropped);
    l1.set_timestamp(1_800_000_200);
    settler.tick(&mut state);

    assert_eq!(state.window.phase, WindowPhase::Evicted);
    assert_eq!(state.metrics.window_count("evicted"), 1.0);
    assert_eq!(
        state.metrics.get(names::GAS_PER_FILL_WEI),
        0.0,
        "no L1 gas was spent"
    );
    for id in &selected {
        assert_eq!(
            state.orders[id].phase,
            OrderPhase::Open,
            "every order stays open for the next window"
        );
    }
}

#[test]
fn fl8_drift_rolls_the_orders_outside_their_limit_and_settles_the_rest() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();

    // The L1 head moves 15% away from the mirror before the boundary.
    l1.set_price(1_700);
    settler.tick(&mut state);

    let selection = state.selection.as_ref().expect("a selection");
    assert!(
        !selection.dropped.is_empty(),
        "some limits are out of reach"
    );
    assert!(!selection.selected.is_empty(), "and some are not");

    let evaluation = selection.evaluation.as_ref().unwrap();
    for fill in &evaluation.fills {
        assert!(
            fill.honours_limit(),
            "nobody is filled worse than their limit (FL-8, CT-10)"
        );
    }
    for id in &selection.dropped {
        assert_eq!(state.orders[id].phase, OrderPhase::Rolled);
    }
    assert!(state.metrics.get(names::ROLL_RATE) > 0.0);
    assert_eq!(front.submitted().len(), 1, "the rest still settle together");
}

#[test]
fn ct7_a_cancel_in_the_sync_block_shrinks_the_selection_and_never_reverts_it() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();

    // A cancel lands in the Sync block, before `settleWindow`.
    l2.push_event(BookEvent::Cancelled {
        id: eight_orders()[2].id,
    });
    settler.tick(&mut state);

    assert_eq!(
        state.attempt.selection().len(),
        7,
        "the selection shrank by one"
    );
    assert!(!state.attempt.selection().contains(&eight_orders()[2].id));
    assert_eq!(front.submitted().len(), 1, "and the settlement still went");
    assert_eq!(
        state.orders[&eight_orders()[2].id].phase,
        OrderPhase::Cancelled
    );
}

#[test]
fn ec4_a_settled_window_reports_no_omitted_orders() {
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();
    settler.tick(&mut state);
    land_the_bundle(&mut state, &l2, &l1, &front);
    settler.tick(&mut state);

    assert_eq!(state.metrics.get(names::SELECTION_OMITTED_TOTAL), 0.0);
    assert!(state.omitted_orders.is_empty());
}

#[test]
fn sv2_two_settlers_with_the_same_inputs_submit_the_same_transaction() {
    // Determinism reaches the wire: same book, same head, same selection, same
    // signed settlement (SV-2).
    let left_chains = chains(eight_orders());
    let right_chains = chains(eight_orders());

    let mut left_state = store();
    Settler::new(&left_chains.0, &left_chains.1, &left_chains.2).tick(&mut left_state);
    let mut right_state = store();
    Settler::new(&right_chains.0, &right_chains.1, &right_chains.2).tick(&mut right_state);

    assert_eq!(
        left_state.attempt.selection(),
        right_state.attempt.selection()
    );
    assert_eq!(left_chains.2.submitted(), right_chains.2.submitted());
}

#[test]
fn sv1_the_settler_survives_a_chain_that_stops_answering() {
    // A task that cannot make progress says so; the loop carries on, and
    // nothing is submitted on a guess.
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();
    settler.tick(&mut state);
    assert_eq!(front.submitted().len(), 1);

    let (l2, _l1, front) = settler.chains();
    // The next window opens and the front refuses the settlement. The window
    // does not settle, and nothing is duplicated.
    l2.set_window(1, 1, 12, fixture_mirror(), 1_800_000_012);
    l2.set_safe_block(18);
    front.set_holds_from_settler(false);
    front.fail_with("front unavailable");
    let mut failures = 0;
    for task in &mut settler.tasks {
        if task.tick(&mut state).is_err() {
            failures += 1;
        }
    }
    assert_eq!(failures, 1, "the submitter said so; nobody else guessed");
    assert_eq!(front.submitted().len(), 1, "nothing was duplicated");
}

#[test]
fn sv4_a_window_is_reconciled_after_the_book_opens_the_next_one() {
    // Regression: `settleWindow` advances `windowId` inside the very
    // transaction whose outcome the reconciler classifies, so on a real chain
    // the book is always one window ahead by the time the settlement is
    // observable. The store used to drop the attempt when it adopted the new
    // window, and with it `windows_total`, every per-settlement metric and
    // EC-4's audit — the reconciler could never resolve a window at all.
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();

    settler.tick(&mut state);
    let tx_hash = state.attempt.tx_hash().expect("a settlement in flight");
    let result = state
        .selection
        .as_ref()
        .and_then(|selection| selection.evaluation.as_ref())
        .expect("a settleable selection")
        .result;

    land_the_bundle(&mut state, &l2, &l1, &front);
    // The Sync block that carried it also filled every order and opened the
    // next window, which is what the book does (CT-9).
    for fill in &state
        .selection
        .as_ref()
        .unwrap()
        .evaluation
        .as_ref()
        .unwrap()
        .fills
    {
        l2.push_event(BookEvent::Filled {
            id: fill.id,
            amount_out: fill.amount_out,
            fee_amount: fill.fee_amount,
            route_fee_amount: fill.route_fee_amount,
            impact_amount: fill.impact_amount,
        });
    }
    l2.push_event(BookEvent::Settled {
        window_id: 0,
        result,
        tx_hash,
        l2_block: 6,
        unix: 1_800_000_012,
    });
    l2.set_window(1, 1, 6, result.post, 1_800_000_012);
    l2.set_open_orders(Vec::new());
    l2.set_safe_block(12);

    settler.tick(&mut state);

    assert_eq!(state.window.id, 1, "the book moved on");
    assert_eq!(
        state.metrics.window_count("settled"),
        1.0,
        "the closing window's outcome is still recorded (SV-4)"
    );
    assert_eq!(state.metrics.get(names::FILLS_PER_SETTLEMENT), 8.0);
    assert!(state.metrics.get(names::GAS_PER_FILL_WEI) > 0.0);
    assert!(state.metrics.get(names::IMPACT_BPS) >= 0.0);
    assert_eq!(
        state.metrics.get(names::SELECTION_OMITTED_TOTAL),
        0.0,
        "EC-4's audit ran, and found nothing omitted"
    );
    assert!(state.metrics.violations().is_empty());
    assert!(
        state.settling.is_none(),
        "a resolved window is not carried into the next one"
    );
    assert_eq!(front.submitted().len(), 1, "and still exactly one");
}

#[test]
fn ec4_an_order_the_settler_omitted_is_caught_after_the_book_moves_on() {
    // The audit that matters is the one on the live path: the settler settled
    // seven of eight fillable orders, the book opened window 1, and the eighth
    // must still be named (EC-4).
    let (l2, l1, front) = chains(eight_orders());
    let mut settler = Settler::new(&l2, &l1, &front);
    let mut state = store();
    settler.tick(&mut state);

    let full = state.attempt.selection().to_vec();
    assert_eq!(full.len(), 8);
    let starved = full[7];

    // Rewrite the attempt to the adversary's selection, keeping the
    // transaction the front holds.
    let tx_hash = state.attempt.tx_hash().unwrap();
    let deadline = state.attempt_deadline().unwrap();
    state.attempt.reform();
    state.attempt.build(full[..7].to_vec()).unwrap();
    state
        .attempt
        .submit(tx_hash, full[..7].to_vec(), 1_800_000_000, deadline)
        .unwrap();

    land_the_bundle(&mut state, &l2, &l1, &front);
    l2.push_event(BookEvent::Settled {
        window_id: 0,
        result: state
            .selection
            .as_ref()
            .unwrap()
            .evaluation
            .as_ref()
            .unwrap()
            .result,
        tx_hash,
        l2_block: 6,
        unix: 1_800_000_012,
    });
    l2.set_window(1, 1, 6, fixture_mirror(), 1_800_000_012);
    l2.set_safe_block(12);

    settler.tick(&mut state);

    assert_eq!(state.metrics.get(names::SELECTION_OMITTED_TOTAL), 1.0);
    assert_eq!(state.omitted_orders, vec![starved]);
    assert_eq!(
        state.metrics.violations(),
        vec![names::SELECTION_OMITTED_TOTAL],
        "the metric that must be zero is not"
    );
}
