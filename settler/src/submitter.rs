//! Submitter — one settlement per window to the L2->L1 front (SV-3).
//!
//! Signed offline, with explicit gas, timed to the slot boundary, with
//! `deadline = sync-block timestamp + DEADLINE_SECONDS`. **Never more than one
//! in flight** — which is [`crate::attempt`]'s to enforce, not this task's: the
//! state machine refuses a second submission, so a bug here cannot become two
//! settlements for one window.
//!
//! Two conditions besides a selection make this task act:
//!
//! * an **empty window** submits a CT-6 refresh, but only when the mirror's age
//!   exceeds `MIRROR_REFRESH_AGE`. Quote demand is not observable on-chain
//!   (`quote` is a view), so the threshold is the sole trigger;
//! * a **known-dropped** settlement is resubmitted exactly **once** (SV-5).
//!
//! And one makes it wait: on a **missed L1 slot** the framework's Sync block is
//! empty and the window stretches. The settler does not resubmit — it waits for
//! the next steady slot.

use crate::chain::{Front, L2Reader, SettlementSigner};
use crate::config::Config;
use crate::math::Q96;
use crate::mirror;
use crate::state::{StateStore, WindowPhase};
use crate::types::OrderId;
use crate::{Task, TaskError};

/// Why the submitter is posting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Submission {
    /// A window with orders to settle (CT-9).
    Settlement {
        /// The selected ids, ascending.
        ids: Vec<OrderId>,
    },
    /// A CT-6 empty settlement, because the mirror aged past
    /// `MIRROR_REFRESH_AGE` with nothing to settle (SV-3).
    Refresh,
}

/// What the submitter decided to do this tick, and why not, when it did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Post this.
    Post(Submission),
    /// Do nothing. The reason is for the log, not for the control flow.
    Hold(HoldReason),
}

/// Why a window was not submitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldReason {
    /// The settler has halted on the unposted-window threshold (SV-4).
    Halted,
    /// The window has not reached its Sync block.
    NotAtBoundary,
    /// The front already holds a settlement for this window (SV-3).
    InFlight,
    /// The window's attempt has already resolved.
    Resolved,
    /// Nothing is selected and the mirror is fresh enough to leave alone.
    NothingToDo,
    /// The window's gross notional is below `MIN_WINDOW_NOTIONAL` (EC-1).
    BelowMinimumNotional,
    /// One resubmission was owed and has been spent (SV-5).
    ResubmissionSpent,
}

/// Posts the settlement transaction.
#[derive(Debug)]
pub struct Submitter<R2, F, S> {
    l2: R2,
    front: F,
    signer: S,
    deadline_seconds: u64,
    mirror_refresh_age: u32,
    min_window_notional: u128,
    l1_gas: u64,
    max_user_txs_per_bundle: u8,
}

impl<R2: L2Reader, F: Front, S: SettlementSigner> Submitter<R2, F, S> {
    /// Builds the submitter from a validated configuration.
    pub fn new(config: &Config, l2: R2, front: F, signer: S) -> Self {
        Self {
            l2,
            front,
            signer,
            deadline_seconds: config.deadline_seconds,
            mirror_refresh_age: config.mirror_refresh_age,
            min_window_notional: config.min_window_notional,
            l1_gas: config.l1_gas,
            max_user_txs_per_bundle: config.max_user_txs_per_bundle,
        }
    }

    /// How many of the bundle's cross-layer slots this DEX consumes: one, per
    /// EC-5, out of `MAX_USER_TXS_PER_BUNDLE`.
    ///
    /// The cap is env-only upstream and not readable from chain or RPC, so the
    /// settler carries it and refuses to run against a node configured below
    /// one — a settlement that cannot fit in a bundle can never land.
    pub fn bundle_slots_used(&self) -> u8 {
        1
    }

    /// Whether the configured bundle cap can carry a settlement at all (EC-5).
    pub fn fits_in_bundle(&self) -> bool {
        self.max_user_txs_per_bundle >= self.bundle_slots_used()
    }

    /// The leg's deadline: `sync-block timestamp + DEADLINE_SECONDS` (SV-3).
    ///
    /// Derived from the L1 head because the deadline is checked on L1 against
    /// `block.timestamp` (CT-1), and the Sync block that will carry this
    /// settlement pins the next L1 slot (CT-8).
    pub fn deadline(&self, l1_head_timestamp: u64) -> u64 {
        l1_head_timestamp + crate::math::L1_SLOT_SECONDS + self.deadline_seconds
    }

    /// What to do with the window as it stands (SV-3).
    ///
    /// Pure over the store, so every branch below is a test rather than a
    /// comment.
    pub fn decide(&self, state: &StateStore) -> Decision {
        if state.halted {
            return Decision::Hold(HoldReason::Halted);
        }
        if state.attempt.is_in_flight() {
            return Decision::Hold(HoldReason::InFlight);
        }
        if state.attempt.owes_resubmission() {
            // A known-dropped window is re-formed and resubmitted once. The
            // ids are re-taken from the current selection, not replayed: an
            // order cancelled since would only be dropped again on-chain.
            let ids = state.attempt.selection().to_vec();
            let ids = if ids.is_empty() {
                state
                    .selection
                    .as_ref()
                    .map(|selection| selection.selected.clone())
                    .unwrap_or_default()
            } else {
                ids
            };
            return if ids.is_empty() {
                Decision::Hold(HoldReason::NothingToDo)
            } else {
                Decision::Post(Submission::Settlement { ids })
            };
        }
        if state.attempt.is_known_dropped() {
            // Dropped, and the one resubmission SV-5 allows is spent. The
            // window re-forms and its orders roll; it is not retried again.
            return Decision::Hold(HoldReason::ResubmissionSpent);
        }
        if state.attempt.is_resolved() {
            return Decision::Hold(HoldReason::Resolved);
        }
        if !state.at_slot_boundary() {
            return Decision::Hold(HoldReason::NotAtBoundary);
        }

        let ids = state.attempt.selection().to_vec();
        if ids.is_empty() {
            // An empty window refreshes the mirror only on age. Quote demand
            // is not observable on-chain, so the threshold is the sole trigger.
            return if state.mirror.age_slots(state.l1.timestamp) > self.mirror_refresh_age {
                Decision::Post(Submission::Refresh)
            } else {
                Decision::Hold(HoldReason::NothingToDo)
            };
        }

        // EC-1's size gate: a window below `MIN_WINDOW_NOTIONAL` does not
        // settle until it grows. At measured gas it rarely binds; it is what
        // keeps the protocol solvent if gas returns to 5+ gwei.
        if self.min_window_notional > 0 && self.gross_notional(state) < self.min_window_notional {
            return Decision::Hold(HoldReason::BelowMinimumNotional);
        }

        Decision::Post(Submission::Settlement { ids })
    }

    /// The window's gross volume before crossing, valued in A (EC-1, A.5).
    fn gross_notional(&self, state: &StateStore) -> u128 {
        let Some(selection) = &state.selection else {
            return 0;
        };
        let Some(evaluation) = &selection.evaluation else {
            return 0;
        };
        let Some(mirror_state) = state.mirror.state.as_ref() else {
            return 0;
        };
        let Ok(price) = mirror::spot_price_x96(mirror_state) else {
            return 0;
        };
        evaluation
            .selection
            .gross_in_a(price)
            .ok()
            .and_then(|gross| u128::try_from(gross).ok())
            .unwrap_or(u128::MAX)
    }

    /// `netting_ratio` for the window about to settle: `1 - |residual| / gross`
    /// (A.5) — the number that carries the economics.
    fn netting_ratio(&self, state: &StateStore) -> Option<f64> {
        let evaluation = state.selection.as_ref()?.evaluation.as_ref()?;
        let price = mirror::spot_price_x96(state.mirror.state.as_ref()?).ok()?;
        let gross = evaluation.selection.gross_in_a(price).ok()?;
        if gross.is_zero() {
            return Some(0.0);
        }
        let residual = evaluation.built.leg.residual_in;
        let residual_in_a = if evaluation.built.residual_is_a {
            residual
        } else {
            crate::math::mul_div(residual, Q96, price).ok()?
        };
        let ratio = f64::from(residual_in_a) / f64::from(gross);
        Some((1.0 - ratio).clamp(0.0, 1.0))
    }
}

impl<R2: L2Reader, F: Front, S: SettlementSigner> Task for Submitter<R2, F, S> {
    fn name(&self) -> &'static str {
        "submitter"
    }

    fn tick(&mut self, state: &mut StateStore) -> Result<(), TaskError> {
        let Decision::Post(submission) = self.decide(state) else {
            return Ok(());
        };
        if !self.fits_in_bundle() {
            return Err(TaskError::Config(crate::ConfigError::Invalid {
                key: "MAX_USER_TXS_PER_BUNDLE",
                reason: "a settlement needs one of the bundle's cross-layer slots (EC-5)".into(),
            }));
        }

        let ids = match &submission {
            Submission::Settlement { ids } => ids.clone(),
            // CT-6: a leg with zero residual that only reads and returns pool
            // state. `settleWindow` builds it from the ids it is given, so an
            // empty list is the only way to ask for one.
            Submission::Refresh => Vec::new(),
        };

        let settler = self.signer.address();
        let nonce = self.l2.nonce(settler)?;
        let fees = self.l2.gas_params(self.l1_gas)?;
        let deadline = self.deadline(state.l1.timestamp);

        let signed = self
            .signer
            .sign_settle_window(&ids, deadline, nonce, fees)?;
        let tx_hash = self.front.submit(&signed.raw)?;

        // A refresh is a settlement attempt for the window like any other: it
        // has a selection (empty), a deadline and one transaction. Recording it
        // as one is what keeps "never more than one in flight" true of a quiet
        // window too (SV-3).
        if !state.attempt.owes_resubmission() {
            state
                .attempt
                .build(ids.clone())
                .map_err(|e| TaskError::Rpc(e.to_string()))?;
        }

        state
            .attempt
            .submit(tx_hash, ids, state.l2_safe.timestamp, deadline)
            .map_err(|e| TaskError::Rpc(e.to_string()))?;
        state.window.transition(WindowPhase::Settling);

        if matches!(submission, Submission::Refresh) {
            state.record_empty_window();
        } else if let Some(ratio) = self.netting_ratio(state) {
            state
                .metrics
                .observe(crate::config::metrics::NETTING_RATIO, ratio);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{
        FakeFront, FakeL1, FakeL2, FakeSigner, fixture_config, fixture_mirror, order, store,
    };
    use crate::types::Side;
    use crate::watcher::Watcher;
    use alloy_primitives::B256;

    fn submitter(l2: &FakeL2, front: &FakeFront) -> Submitter<FakeL2, FakeFront, FakeSigner> {
        Submitter::new(&fixture_config(), l2.clone(), front.clone(), FakeSigner)
    }

    /// A store at the slot boundary with a selection already built.
    fn ready(orders: Vec<crate::types::Order>, l1: &FakeL1) -> (StateStore, FakeL2) {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_open_orders(orders);
        l2.set_safe_block(6);
        Watcher::new(l2.clone(), l1.clone(), 0)
            .tick(&mut state)
            .unwrap();
        crate::builder::WindowBuilder::new(&fixture_config(), l1.simulator())
            .tick(&mut state)
            .unwrap();
        (state, l2)
    }

    fn two_orders() -> Vec<crate::types::Order> {
        vec![
            order(
                1,
                Side::SellAForB,
                "10000000000000000000",
                "19000000000000000000000",
            ),
            order(
                2,
                Side::SellBForA,
                "10000000000000000000000",
                "4900000000000000000",
            ),
        ]
    }

    #[test]
    fn sv3_exactly_one_settlement_per_window_reaches_the_front() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let mut submitter = submitter(&l2, &front);

        submitter.tick(&mut state).unwrap();
        assert_eq!(front.submitted().len(), 1);
        assert!(state.attempt.is_in_flight());
        assert_eq!(state.window.phase, WindowPhase::Settling);

        // Every later tick of the same window posts nothing: the front holds it.
        for _ in 0..5 {
            submitter.tick(&mut state).unwrap();
        }
        assert_eq!(front.submitted().len(), 1, "one window, one settlement");
        assert_eq!(
            submitter.decide(&state),
            Decision::Hold(HoldReason::InFlight)
        );
    }

    #[test]
    fn sv3_nothing_is_submitted_before_the_slot_boundary() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        state.l2_safe.number = 3;
        let front = FakeFront::new();

        assert_eq!(
            submitter(&l2, &front).decide(&state),
            Decision::Hold(HoldReason::NotAtBoundary)
        );
        submitter(&l2, &front).tick(&mut state).unwrap();
        assert!(front.submitted().is_empty());
    }

    #[test]
    fn sv3_an_empty_window_refreshes_the_mirror_only_on_age() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(Vec::new(), &l1);
        let front = FakeFront::new();

        // Fresh mirror: nothing to do, even with no orders at all.
        assert_eq!(
            submitter(&l2, &front).decide(&state),
            Decision::Hold(HoldReason::NothingToDo)
        );

        // `MIRROR_REFRESH_AGE` defaults to 5 slots; at exactly five it still
        // holds, and past it the CT-6 refresh goes.
        l1.set_timestamp(1_800_000_000 + 5 * 12);
        state.l1.timestamp = 1_800_000_060;
        assert_eq!(
            submitter(&l2, &front).decide(&state),
            Decision::Hold(HoldReason::NothingToDo)
        );

        state.l1.timestamp = 1_800_000_072;
        assert_eq!(
            submitter(&l2, &front).decide(&state),
            Decision::Post(Submission::Refresh)
        );
        submitter(&l2, &front).tick(&mut state).unwrap();
        assert_eq!(front.submitted().len(), 1);
        assert!(
            state.attempt.selection().is_empty(),
            "CT-6: no orders, no swap"
        );
        assert_eq!(state.metrics.window_count("empty"), 1.0);
    }

    #[test]
    fn sv3_a_missed_l1_slot_stretches_the_window_rather_than_resubmitting() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let mut submitter = submitter(&l2, &front);
        submitter.tick(&mut state).unwrap();

        // The Sync block was empty; the window stretches. Nothing is posted.
        state.attempt.note_missed_slot();
        state.attempt.note_missed_slot();
        submitter.tick(&mut state).unwrap();
        assert_eq!(
            front.submitted().len(),
            1,
            "the settler waits for the next slot"
        );
        assert!(state.attempt.is_in_flight());
    }

    #[test]
    fn sv5_a_known_dropped_window_is_resubmitted_exactly_once() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let mut submitter = submitter(&l2, &front);
        submitter.tick(&mut state).unwrap();
        let first = front.submitted()[0];

        // Three consecutive relay drops evict it (SV-5).
        for _ in 0..3 {
            state.attempt.note_relay_drop();
        }
        assert!(state.attempt.owes_resubmission());

        // The resubmission takes a fresh nonce from the chain rather than
        // replaying the one it signed with.
        l2.set_nonce(1);
        submitter.tick(&mut state).unwrap();
        assert_eq!(front.submitted().len(), 2, "re-formed and resubmitted once");
        assert!(state.attempt.is_in_flight());

        // The resubmission is dropped too. There is no third attempt.
        for _ in 0..3 {
            state.attempt.note_relay_drop();
        }
        assert!(!state.attempt.owes_resubmission());
        assert_eq!(
            submitter.decide(&state),
            Decision::Hold(HoldReason::ResubmissionSpent)
        );
        submitter.tick(&mut state).unwrap();
        assert_eq!(
            front.submitted().len(),
            2,
            "one resubmission, not a retry loop"
        );
        assert_ne!(first, front.submitted()[1], "a fresh nonce, a fresh hash");
    }

    #[test]
    fn sv4_a_halted_settler_submits_nothing() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        state.halted = true;
        let front = FakeFront::new();

        assert_eq!(
            submitter(&l2, &front).decide(&state),
            Decision::Hold(HoldReason::Halted)
        );
        submitter(&l2, &front).tick(&mut state).unwrap();
        assert!(front.submitted().is_empty());
    }

    #[test]
    fn ec1_a_window_below_the_minimum_notional_waits_to_grow() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let mut config = fixture_config();
        // The fixture window is ~20 A gross; ask for 1000.
        config.min_window_notional = 1_000_000_000_000_000_000_000;
        let submitter = Submitter::new(&config, l2.clone(), front.clone(), FakeSigner);

        assert_eq!(
            submitter.decide(&state),
            Decision::Hold(HoldReason::BelowMinimumNotional)
        );

        config.min_window_notional = 1;
        let mut submitter = Submitter::new(&config, l2, front.clone(), FakeSigner);
        submitter.tick(&mut state).unwrap();
        assert_eq!(front.submitted().len(), 1);
    }

    #[test]
    fn a5_netting_ratio_is_recorded_for_the_window_that_settles() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        submitter(&l2, &front).tick(&mut state).unwrap();

        let ratio = state.metrics.get(crate::config::metrics::NETTING_RATIO);
        // Two roughly equal sides net about half the window away.
        // 10 A against 10,000 B is 15 A of gross at the mirror's 2000, and a
        // 5 A residual: two thirds of the flow never touched mainnet.
        assert!(
            (0.66..0.67).contains(&ratio),
            "netting_ratio was {ratio}, expected about two thirds"
        );
    }

    #[test]
    fn ec5_a_bundle_cap_below_one_cannot_carry_a_settlement() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let mut config = fixture_config();
        config.max_user_txs_per_bundle = 0;
        let mut submitter = Submitter::new(&config, l2, front.clone(), FakeSigner);

        assert!(!submitter.fits_in_bundle());
        assert!(submitter.tick(&mut state).is_err());
        assert!(front.submitted().is_empty());
    }

    #[test]
    fn sv3_a_front_that_refuses_the_transaction_leaves_the_window_unsettled() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        front.fail_with("front unavailable");

        assert!(submitter(&l2, &front).tick(&mut state).is_err());
        assert!(!state.attempt.is_in_flight(), "nothing is in flight");
        assert_eq!(state.window.phase, WindowPhase::Open);

        // And the next tick posts it, once.
        submitter(&l2, &front).tick(&mut state).unwrap();
        assert_eq!(front.submitted().len(), 1);
    }

    #[test]
    fn sv3_the_selection_reaches_the_front_ascending_and_unchanged() {
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        let selected = state.attempt.selection().to_vec();
        submitter(&l2, &front).tick(&mut state).unwrap();

        assert_eq!(state.attempt.selection(), selected.as_slice());
        let mut ascending = selected.clone();
        ascending.sort_unstable();
        assert_eq!(selected, ascending, "ids are ascending (SV-2)");
    }

    #[test]
    fn sv5_a_settlement_the_front_still_holds_is_never_resubmitted_after_a_restart() {
        // What survives a restart is the attempt's id and its state. The
        // submitter reads that state and holds, which is the whole of SV-5's
        // "recognised by its id and reconciled, never resubmitted".
        let l1 = FakeL1::at(2000);
        let (mut state, l2) = ready(two_orders(), &l1);
        let front = FakeFront::new();
        submitter(&l2, &front).tick(&mut state).unwrap();
        let tx_hash = state.attempt.tx_hash().unwrap();

        // A fresh submitter, as after a restart, over the same state.
        let mut restarted = submitter(&l2, &front);
        restarted.tick(&mut state).unwrap();
        assert_eq!(front.submitted(), vec![tx_hash]);
        assert_ne!(tx_hash, B256::ZERO);
    }
}
