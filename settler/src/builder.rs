//! Window builder — cross, residual, simulation, selection (SV-2, FL-8).
//!
//! At the slot boundary: read the open orders, compute the cross and the
//! residual, simulate `SettlementRouter.settle` against the L1 head with
//! `eth_call`, derive the clearing price, then drop limit-violating orders and
//! re-simulate until stable. The arithmetic is [`crate::window`] and the loop
//! is [`crate::selection`]; this task is the wiring, and it is deliberately
//! thin — everything worth testing about selection is a pure function.
//!
//! The output is a suggestion. `WindowBook.settleWindow` rebuilds the leg from
//! the still-open subset and the contract enforces every limit (CT-9, CT-10).

use crate::config::Config;
use crate::math::L1_SLOT_SECONDS;
use crate::selection::{LegSimulator, Selection, SelectionInputs, select_fillable};
use crate::state::{OrderPhase, StateStore};
use crate::{Task, TaskError};

/// Selects the fillable subset for the window about to close.
#[derive(Debug)]
pub struct WindowBuilder<S> {
    simulator: S,
    deadline_seconds: u64,
}

impl<S: LegSimulator> WindowBuilder<S> {
    /// Builds the window builder over the L1 simulator (SV-2).
    pub fn new(config: &Config, simulator: S) -> Self {
        Self {
            simulator,
            deadline_seconds: config.deadline_seconds,
        }
    }

    /// The leg's deadline: `sync-block timestamp + DEADLINE_SECONDS` (SV-3).
    ///
    /// The Sync block's timestamp equals the pinned L1 slot time (CT-8), and
    /// the Sync block that will carry this settlement pins the *next* L1 slot,
    /// so the sync-block timestamp is one slot past the head the settler can
    /// see. The deadline is checked on L1 against `block.timestamp` (CT-1),
    /// which is why it is derived from L1's clock and not from L2's.
    pub fn deadline(&self, l1_head_timestamp: u64) -> u64 {
        l1_head_timestamp + L1_SLOT_SECONDS + self.deadline_seconds
    }

    /// The inclusion-maximal selection for `state`'s open window (FL-8).
    ///
    /// Pure with respect to the store: identical state produces an identical
    /// selection on any settler (SV-2), which is what makes TS-3's permutation
    /// property testable.
    pub fn select(&self, state: &StateStore) -> Option<Selection> {
        let params = state.book.as_ref()?;
        let mirror = state.mirror.state.as_ref()?;
        Some(select_fillable(
            &state.open_orders(),
            SelectionInputs {
                params,
                mirror,
                window_id: state.window.id,
                deadline: self.deadline(state.l1.timestamp),
            },
            &self.simulator,
        ))
    }
}

impl<S: LegSimulator> Task for WindowBuilder<S> {
    fn name(&self) -> &'static str {
        "builder"
    }

    fn tick(&mut self, state: &mut StateStore) -> Result<(), TaskError> {
        // A halted settler accepts no settlements (SV-4).
        if state.halted {
            return Ok(());
        }
        // Selection happens at the slot boundary and nowhere else: an earlier
        // one would be simulated against a head the leg will not execute at.
        if !state.at_slot_boundary() {
            return Ok(());
        }
        // One settlement per window. While the front holds one, or one is
        // owed its single resubmission, there is nothing to select (SV-3).
        if state.attempt.is_in_flight() || state.attempt.is_resolved() {
            return Ok(());
        }

        let Some(selection) = self.select(state) else {
            // The watcher has not reached the book yet.
            return Ok(());
        };

        if let Some(reason) = &selection.blocked {
            // The simulator could not answer. That is not a window where
            // everyone rolled, and recording it as one would make an L1 outage
            // indistinguishable from a market that moved (SV-2).
            return Err(TaskError::Rpc(reason.clone()));
        }

        // The A.4 order machine, applied to the settler's own suggestion.
        for id in &selection.selected {
            if let Some(tracked) = state.orders.get_mut(id) {
                tracked.transition(OrderPhase::Selected);
            }
        }
        for id in &selection.dropped {
            if let Some(tracked) = state.orders.get_mut(id) {
                tracked.transition(OrderPhase::Rolled);
            }
        }
        state.recompute_roll_rate();

        state.selection = Some(selection.clone());
        if !selection.selected.is_empty() {
            state
                .attempt
                .build(selection.selected)
                .map_err(|e| TaskError::Rpc(e.to_string()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{
        FakeL1, FakeL2, fixture_config, fixture_mirror, fixture_params, order, store,
    };
    use crate::types::{OrderId, Side};
    use crate::watcher::Watcher;

    /// Eight orders across both sides, limits spread around the mirror's 2000.
    fn eight_orders() -> Vec<crate::types::Order> {
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

    /// A store at the slot boundary with `orders` open.
    fn at_boundary(orders: Vec<crate::types::Order>, l1: &FakeL1) -> StateStore {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_open_orders(orders);
        l2.set_safe_block(6);
        Watcher::new(l2, l1.clone(), 0).tick(&mut state).unwrap();
        assert!(state.at_slot_boundary());
        state
    }

    fn builder(l1: &FakeL1) -> WindowBuilder<crate::selection::MirrorSimulator> {
        WindowBuilder::new(&fixture_config(), l1.simulator())
    }

    #[test]
    fn sv3_the_deadline_is_the_sync_blocks_timestamp_plus_deadline_seconds() {
        let l1 = FakeL1::at(2000);
        // DEADLINE_SECONDS defaults to 24, and the Sync block pins the next
        // L1 slot, one slot past the head the settler can see.
        assert_eq!(builder(&l1).deadline(1_800_000_000), 1_800_000_036);
    }

    #[test]
    fn sv2_the_builder_selects_at_the_boundary_and_not_before() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        state.l2_safe.number = 3; // mid-window
        assert!(!state.at_slot_boundary());

        builder(&l1).tick(&mut state).unwrap();
        assert!(state.selection.is_none(), "nothing is selected mid-window");

        state.l2_safe.number = 6;
        builder(&l1).tick(&mut state).unwrap();
        let selection = state
            .selection
            .as_ref()
            .expect("a selection at the boundary");
        assert_eq!(selection.selected.len(), 8, "a quiet head fills everyone");
        assert_eq!(state.attempt.selection(), selection.selected.as_slice());
    }

    #[test]
    fn fl8_drift_marks_the_orders_outside_their_limit_as_rolled() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        l1.set_price(1_700);

        builder(&l1).tick(&mut state).unwrap();
        let selection = state.selection.as_ref().unwrap();
        assert!(
            !selection.dropped.is_empty(),
            "a 15% move costs some limits"
        );

        for id in &selection.selected {
            assert_eq!(state.orders[id].phase, OrderPhase::Selected);
        }
        for id in &selection.dropped {
            assert_eq!(state.orders[id].phase, OrderPhase::Rolled);
            assert_eq!(state.orders[id].rolled_count, 1, "FE-7 counts the roll");
        }
        assert!(state.metrics.get(crate::config::metrics::ROLL_RATE) > 0.0);
    }

    #[test]
    fn ct10_the_builder_never_selects_an_order_it_knows_would_revert() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        l1.set_price(1_750);
        builder(&l1).tick(&mut state).unwrap();

        let evaluation = state
            .selection
            .as_ref()
            .unwrap()
            .evaluation
            .as_ref()
            .expect("a settleable selection");
        for fill in &evaluation.fills {
            assert!(
                fill.honours_limit(),
                "the contract is the last check, not the first"
            );
        }
    }

    #[test]
    fn sv3_the_builder_does_not_select_while_a_settlement_is_in_flight() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        state
            .attempt
            .build(vec![OrderId::with_last_byte(1)])
            .unwrap();
        state
            .attempt
            .submit(
                alloy_primitives::B256::repeat_byte(0xaa),
                vec![OrderId::with_last_byte(1)],
                1_800_000_000,
                1_800_000_024,
            )
            .unwrap();

        builder(&l1).tick(&mut state).unwrap();
        assert!(state.selection.is_none(), "one window, one settlement");
        assert_eq!(state.attempt.selection(), [OrderId::with_last_byte(1)]);
    }

    #[test]
    fn sv4_a_halted_settler_selects_nothing() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        state.halted = true;
        builder(&l1).tick(&mut state).unwrap();
        assert!(state.selection.is_none());
    }

    #[test]
    fn sv2_an_unanswered_simulation_is_an_error_not_an_empty_window() {
        struct Dead;
        impl LegSimulator for Dead {
            fn simulate(
                &self,
                _leg: &crate::types::WindowLeg,
            ) -> Result<crate::types::WindowResult, crate::selection::SimulationError> {
                Err(crate::selection::SimulationError::Unavailable(
                    "l1 rpc timed out".into(),
                ))
            }
        }
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(eight_orders(), &l1);
        let error = WindowBuilder::new(&fixture_config(), Dead)
            .tick(&mut state)
            .unwrap_err();
        assert!(error.to_string().contains("l1 rpc timed out"));
        assert!(
            state.selection.is_none(),
            "nobody rolled; the settler is blind"
        );
    }

    #[test]
    fn sv2_an_empty_book_selects_nothing_and_builds_no_attempt() {
        let l1 = FakeL1::at(2000);
        let mut state = at_boundary(Vec::new(), &l1);
        builder(&l1).tick(&mut state).unwrap();
        let selection = state.selection.as_ref().unwrap();
        assert!(selection.selected.is_empty());
        assert!(state.attempt.selection().is_empty());
    }

    #[test]
    fn sv2_the_builder_uses_the_books_mirror_to_cross_and_the_l1_head_to_swap() {
        // The window nets at the mirror price and the leg executes at the head
        // (CT-9, FL-5). A builder that crossed at the head would put the
        // settler's arithmetic at odds with the contract's.
        let l1 = FakeL1::at(1_900);
        let state = at_boundary(eight_orders(), &l1);
        let selection = builder(&l1).select(&state).unwrap();
        let evaluation = selection.evaluation.unwrap();

        let mirror_price = crate::mirror::spot_price_x96(&fixture_mirror()).unwrap();
        let head_price = crate::mirror::spot_price_x96(&l1.simulator().head).unwrap();
        assert_ne!(mirror_price, head_price);
        assert_eq!(
            evaluation.result.reference_price_x96, head_price,
            "P0 is read inside the leg, at the head"
        );
        // And the fee shape came from the book, not from the settler's config.
        assert_eq!(state.book.unwrap(), fixture_params());
    }
}
