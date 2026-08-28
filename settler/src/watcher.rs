//! Watcher — the open window's orders, the L1 head, the pool's live state (A.5).
//!
//! It is the only task that reads the chains for state; the other three read
//! the store. That is what makes the window builder a pure function of things
//! already observed, and what lets a restart take the same path as a cold
//! start: **window state rebuilds from L2 logs** (SV-5), and the log scan does
//! not care whether this process saw them the first time.

use alloy_primitives::Address;

use crate::chain::{BookEvent, L1Reader, L2Reader};
use crate::state::{OrderPhase, StateStore, TrackedOrder};
use crate::{Task, TaskError};

/// Tracks `WindowBook` logs on L2 and the target pool on L1.
#[derive(Debug)]
pub struct Watcher<R2, R1> {
    l2: R2,
    l1: R1,
    /// The next L2 block the log scan starts from.
    cursor: u64,
    /// False until the first tick has seeded from the book's own view.
    seeded: bool,
}

impl<R2: L2Reader, R1: L1Reader> Watcher<R2, R1> {
    /// Builds the watcher over the two chains, starting its log scan at
    /// `from_block`.
    pub fn new(l2: R2, l1: R1, from_block: u64) -> Self {
        Self {
            l2,
            l1,
            cursor: from_block,
            seeded: false,
        }
    }

    /// The next L2 block the log scan will start from.
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Applies one `WindowBook` log to the store (CT-7, CT-9).
    fn apply(&self, state: &mut StateStore, event: BookEvent) {
        match event {
            BookEvent::Placed {
                order,
                l2_block,
                unix,
            } => {
                state
                    .orders
                    .entry(order.id)
                    .or_insert_with(|| TrackedOrder::placed(order, l2_block, unix));
            }
            BookEvent::Cancelled { id } => {
                if let Some(tracked) = state.orders.get_mut(&id) {
                    tracked.transition(OrderPhase::Cancelled);
                }
            }
            BookEvent::Expired { id } => {
                if let Some(tracked) = state.orders.get_mut(&id) {
                    tracked.transition(OrderPhase::Expired);
                }
            }
            BookEvent::Filled { id, .. } => {
                if let Some(tracked) = state.orders.get_mut(&id) {
                    // A fill goes through `selected`; an order the settler did
                    // not know it had selected still filled, so record both.
                    tracked.transition(OrderPhase::Selected);
                    tracked.transition(OrderPhase::Filled);
                }
            }
            BookEvent::Settled { .. } => {
                // The reconciler owns settlements: matching one to its L1
                // receipt is its whole job (SV-4). The watcher only carries it.
            }
        }
    }
}

impl<R2: L2Reader, R1: L1Reader> Task for Watcher<R2, R1> {
    fn name(&self) -> &'static str {
        "watcher"
    }

    fn tick(&mut self, state: &mut StateStore) -> Result<(), TaskError> {
        // The book's own parameters, once. It is the authority on the fee it
        // charges, so the settler reads them rather than carrying a copy that
        // could disagree (CT-12).
        if state.book.is_none() {
            state.book = Some(self.l2.book_params()?);
        }

        // The L1 head and the pool at it. CT-1's deadline is a timestamp
        // checked here, so the head's timestamp is a fact the settler needs.
        let head = self.l1.head()?;
        state.l1.block = head.number;
        state.l1.timestamp = head.timestamp;
        state.l1.pool = Some(self.l1.pool_state()?);

        // The L2 safe head — one L1 confirmation, revocable. Operations read
        // here; accounting reads `finalized` (SV-4).
        let safe = self.l2.safe_head()?;
        state.l2_safe = safe;

        // The window and the mirror it will net at.
        let window = self.l2.window()?;
        if window.id == state.window.id {
            state.sync_window(window.start_block, window.slots);
        } else {
            state.adopt_window(window.id, window.start_block, safe.timestamp, window.slots);
        }
        state.mirror.state = Some(window.mirror);
        state.mirror.stamped_at = window.mirror_timestamp;
        state.mirror.reference_price_x96 = window.reference_price_x96;
        state.mirror.reference_l1_block = window.reference_l1_block;
        state.record_mirror_age(safe.timestamp);

        // A cold start and a restart take the same path: the book's open set
        // seeds the store, and the logs carry it forward (SV-5).
        if !self.seeded {
            for order in self.l2.open_orders()? {
                state
                    .orders
                    .entry(order.id)
                    .or_insert_with(|| TrackedOrder::placed(order, safe.number, safe.timestamp));
            }
            self.seeded = true;
        }

        let events = self.l2.events_since(self.cursor)?;
        let mut settlements = Vec::new();
        for event in events {
            if let Some(block) = event.l2_block() {
                self.cursor = self.cursor.max(block + 1);
            }
            if matches!(event, BookEvent::Settled { .. }) {
                settlements.push(event.clone());
            }
            self.apply(state, event);
        }
        state.observed_settlements.extend(settlements);
        self.cursor = self.cursor.max(safe.number + 1);

        // CT-13, per asset, at the safe head. Must be zero.
        if let Some(book) = state.book {
            for asset in [book.asset_a, book.asset_b] {
                let drift = self.l2.escrow_drift(asset)?;
                state.record_escrow_drift(asset, drift);
            }
        }
        state.recompute_roll_rate();

        Ok(())
    }
}

impl From<crate::chain::ChainError> for TaskError {
    fn from(error: crate::chain::ChainError) -> Self {
        Self::Rpc(error.to_string())
    }
}

/// The assets a book trades, for the CT-13 sweep.
pub fn book_assets(asset_a: Address, asset_b: Address) -> [Address; 2] {
    [asset_a, asset_b]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{FakeL1, FakeL2, fixture_mirror, order, store, wei};
    use crate::types::{OrderId, Side};

    #[test]
    fn sv5_window_state_rebuilds_from_l2_logs() {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(3, 1, 18, fixture_mirror(), 1_800_000_000);
        l2.push_event(BookEvent::Placed {
            order: order(1, Side::SellAForB, "1000000000000000000", "0"),
            l2_block: 19,
            unix: 1_800_000_002,
        });
        l2.push_event(BookEvent::Placed {
            order: order(2, Side::SellBForA, "2000000000000000000000", "0"),
            l2_block: 20,
            unix: 1_800_000_004,
        });
        l2.push_event(BookEvent::Cancelled {
            id: OrderId::with_last_byte(2),
        });

        let mut watcher = Watcher::new(l2.clone(), FakeL1::at(2000), 0);
        watcher.tick(&mut state).unwrap();

        assert_eq!(state.window.id, 3, "the book's window, not a guess");
        assert_eq!(state.orders.len(), 2);
        assert_eq!(
            state.open_orders().iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![OrderId::with_last_byte(1)],
            "the cancel took order 2 out of the selection (CT-7)"
        );
        assert_eq!(
            state.orders[&OrderId::with_last_byte(1)].placed_at_l2_block,
            19
        );
    }

    #[test]
    fn sv5_a_restart_re_reads_the_same_logs_and_reaches_the_same_state() {
        let l2 = FakeL2::new();
        l2.set_window(1, 2, 6, fixture_mirror(), 1_800_000_000);
        for id in 1..=4u8 {
            l2.push_event(BookEvent::Placed {
                order: order(id, Side::SellAForB, "1000000000000000000", "0"),
                l2_block: u64::from(id) + 6,
                unix: 1_800_000_000 + u64::from(id) * 2,
            });
        }

        let mut first = store();
        Watcher::new(l2.clone(), FakeL1::at(2000), 0)
            .tick(&mut first)
            .unwrap();

        // A fresh process, a fresh store, the same logs.
        let mut restarted = store();
        Watcher::new(l2.clone(), FakeL1::at(2000), 0)
            .tick(&mut restarted)
            .unwrap();

        assert_eq!(first.orders, restarted.orders);
        assert_eq!(first.window, restarted.window);
    }

    #[test]
    fn a5_the_watcher_records_the_l1_head_the_pool_and_the_mirrors_age() {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_head_timestamp(1_800_000_060);
        let l1 = FakeL1::at(2100);

        Watcher::new(l2, l1, 0).tick(&mut state).unwrap();

        assert_eq!(state.l1.block, 1_000);
        assert!(state.l1.pool.is_some(), "the pool's live state (A.5)");
        assert!(state.book.is_some(), "the book's own parameters (CT-12)");
        assert_eq!(
            state.metrics.get(crate::config::metrics::MIRROR_AGE_SLOTS),
            5.0,
            "60 seconds is five slots (CT-8)"
        );
    }

    #[test]
    fn ct13_the_watcher_publishes_the_escrow_drift_of_both_assets() {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_escrow_drift(Address::with_last_byte(0xb0), -3);

        Watcher::new(l2, FakeL1::at(2000), 0)
            .tick(&mut state)
            .unwrap();

        assert_eq!(
            state
                .metrics
                .get(crate::config::metrics::ESCROW_INVARIANT_DRIFT_WEI),
            -3.0
        );
        assert_eq!(
            state.metrics.violations(),
            vec![crate::config::metrics::ESCROW_INVARIANT_DRIFT_WEI]
        );
    }

    #[test]
    fn a4_a_settlement_log_is_carried_for_the_reconciler_not_applied_here() {
        let mut state = store();
        let l2 = FakeL2::new();
        l2.set_window(1, 1, 6, fixture_mirror(), 1_800_000_012);
        l2.push_event(BookEvent::Settled {
            window_id: 0,
            result: crate::types::WindowResult {
                amount_in: wei("1"),
                amount_out: wei("2"),
                reference_price_x96: wei("3"),
                execution_price_x96: wei("4"),
                post: fixture_mirror(),
                l1_block: 5,
            },
            tx_hash: alloy_primitives::B256::repeat_byte(0xaa),
            l2_block: 6,
            unix: 1_800_000_012,
        });

        Watcher::new(l2, FakeL1::at(2000), 0)
            .tick(&mut state)
            .unwrap();
        assert_eq!(state.observed_settlements.len(), 1);
    }

    #[test]
    fn sv5_the_log_cursor_only_moves_forward() {
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_safe_block(40);
        let mut watcher = Watcher::new(l2, FakeL1::at(2000), 0);
        let mut state = store();

        watcher.tick(&mut state).unwrap();
        assert_eq!(watcher.cursor(), 41);
        watcher.tick(&mut state).unwrap();
        assert_eq!(
            watcher.cursor(),
            41,
            "a repeated safe head does not rewind it"
        );
    }
}
