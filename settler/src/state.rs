//! The one state store the four tasks share (SV-1).
//!
//! What it holds, and why each is state rather than a derivation:
//!
//! * the open window's orders, rebuilt from L2 logs on restart (SV-5);
//! * the L1 head and the target pool's live state (A.5, watcher);
//! * the current settlement attempt. In-flight versus known-dropped is
//!   **explicit state, never inferred from a timer alone** (SV-5), which is
//!   [`crate::attempt`];
//! * the per-asset escrow drift the reconciler checks against CT-13;
//! * the measured order flow that sets `WINDOW_SLOTS` at the boundary (EC-6);
//! * the metric values of [`crate::config::metrics`].
//!
//! The store is plain data with no I/O of its own: the tasks read the chains
//! and write here, which is what lets the whole service be driven from a test
//! without a chain behind it.
//!
//! **Determinism.** Orders live in a `BTreeMap` keyed by id, so every walk of
//! the book is in ascending id order — the canonical order (SV-2). Nothing in
//! this crate iterates a hash map.

use std::collections::{BTreeMap, VecDeque};

use alloy_primitives::{Address, B256};

use crate::attempt::{Attempt, Outcome};
use crate::config::{Config, WindowSlots, metrics as names};
use crate::math;
use crate::metrics::Metrics;
use crate::types::{Order, OrderId, PoolState};
use crate::window::BookParams;

/// How many windows of order flow the EC-6 meter averages over.
const FLOW_HORIZON_WINDOWS: usize = 8;

/// Where the open window is — IX-2's `WindowState`, which is A.4's machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowPhase {
    /// Taking orders.
    Open,
    /// A settlement has been submitted for it.
    Settling,
    /// `WindowSettled`, matched to an L1 receipt.
    Settled,
    /// Poison-evicted at compose time, for free (FL-7).
    Evicted,
    /// The bundle was missed, reorged, or its L1 entry skipped at `postBatch`.
    RolledBack,
}

impl WindowPhase {
    /// A.4's window machine, as IX-2 tabulates it. An evicted or rolled-back
    /// window returns to `open` with its orders intact; `settled -> rolled_back`
    /// is the case the demo turns on.
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Open, Self::Settling)
                | (
                    Self::Settling,
                    Self::Settled | Self::Evicted | Self::RolledBack
                )
                | (Self::Settled, Self::RolledBack)
                | (Self::Evicted | Self::RolledBack, Self::Open)
        )
    }

    /// The IX-2 wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Settling => "settling",
            Self::Settled => "settled",
            Self::Evicted => "evicted",
            Self::RolledBack => "rolled_back",
        }
    }
}

/// Where an order is — IX-2's `OrderState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderPhase {
    /// In the open window (CT-7).
    Open,
    /// In the settler's suggested selection (FL-8).
    Selected,
    /// Settled (CT-9).
    Filled,
    /// Its limit was not met at the boundary; it remains open next window.
    Rolled,
    /// Cancelled by its owner.
    Cancelled,
    /// Past `expiresAfter` windows.
    Expired,
}

impl OrderPhase {
    /// A.4's order machine, as IX-2 tabulates it. `rolled` is not terminal;
    /// `filled -> open` and `selected -> open` exist because a rolled-back
    /// bundle undoes fills and leaves the order open and intact.
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Open,
                Self::Selected | Self::Rolled | Self::Cancelled | Self::Expired
            ) | (Self::Selected, Self::Filled | Self::Rolled | Self::Open)
                | (Self::Filled | Self::Rolled, Self::Open)
        )
    }

    /// Whether the book would still select this order (CT-9).
    pub fn is_open(self) -> bool {
        matches!(self, Self::Open | Self::Selected | Self::Rolled)
    }

    /// The IX-2 wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Selected => "selected",
            Self::Filled => "filled",
            Self::Rolled => "rolled",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }
}

/// An order as the settler tracks it, with the IX-2 fields the book's own
/// storage does not carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedOrder {
    /// The order as the book holds it.
    pub order: Order,
    /// Where it is in A.4's machine.
    pub phase: OrderPhase,
    /// The L2 block it was placed in.
    pub placed_at_l2_block: u64,
    /// The unix second it was placed at.
    pub placed_at_unix: u64,
    /// How many windows it has rolled through — the numerator of `roll_rate`.
    pub rolled_count: u32,
}

impl TrackedOrder {
    /// A newly observed `OrderPlaced` (CT-7).
    pub fn placed(order: Order, l2_block: u64, unix: u64) -> Self {
        Self {
            order,
            phase: OrderPhase::Open,
            placed_at_l2_block: l2_block,
            placed_at_unix: unix,
            rolled_count: 0,
        }
    }

    /// Moves the order, refusing a transition A.4 does not allow. A transition
    /// the spec does not name is a bug in whichever task asked for it, not a
    /// case for the indexer to render.
    pub fn transition(&mut self, next: OrderPhase) -> bool {
        if self.phase == next || !self.phase.can_transition_to(next) {
            return self.phase == next;
        }
        if next == OrderPhase::Rolled {
            self.rolled_count += 1;
        }
        self.phase = next;
        true
    }
}

/// The mirror, as the book holds it (FL-1, CT-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MirrorState {
    /// The working copy of the pool.
    pub state: Option<PoolState>,
    /// The L2 timestamp it was stamped at.
    pub stamped_at: u64,
    /// The last settlement's `P0` (CT-14).
    pub reference_price_x96: alloy_primitives::U256,
    /// The L1 block that `P0` was read in.
    pub reference_l1_block: u64,
}

impl MirrorState {
    /// Its age in L1 slots at `now` — `(now - mirrorTimestamp) / 12` (CT-8).
    pub fn age_slots(&self, now: u64) -> u32 {
        math::age_slots(now, self.stamped_at)
    }
}

/// The L1 head and the target pool's live state (A.5, watcher).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct L1Head {
    /// The head block number.
    pub block: u64,
    /// Its timestamp — what CT-1's deadline is checked against.
    pub timestamp: u64,
    /// The pool at that head. `None` until the watcher has read it once.
    pub pool: Option<PoolState>,
}

/// Order flow, measured over the last few windows (EC-6).
///
/// `WINDOW_SLOTS` is 2 below `FLOW_THRESHOLD` orders per slot and 1 above it,
/// and the switch happens at the window boundary — never inside a window,
/// where it would change the length of a window already being traded.
#[derive(Debug, Clone, Default)]
pub struct FlowMeter {
    history: VecDeque<(u32, u8)>,
}

impl FlowMeter {
    /// Records one closed window's order count and length in slots.
    pub fn record_window(&mut self, orders: u32, slots: u8) {
        self.history.push_back((orders, slots));
        while self.history.len() > FLOW_HORIZON_WINDOWS {
            self.history.pop_front();
        }
    }

    /// Orders per slot over the horizon. Zero until a window has closed.
    pub fn orders_per_slot(&self) -> f64 {
        let (orders, slots) = self
            .history
            .iter()
            .fold((0u64, 0u64), |(o, s), (orders, slots)| {
                (o + u64::from(*orders), s + u64::from(*slots))
            });
        if slots == 0 {
            0.0
        } else {
            orders as f64 / slots as f64
        }
    }

    /// The EC-6 setting the measured flow calls for.
    ///
    /// Two slots below the threshold, one above. Until a window has closed
    /// there is no measurement, so the configured default stands.
    pub fn desired_slots(&self, threshold: f64, configured: WindowSlots) -> WindowSlots {
        if self.history.is_empty() {
            return configured;
        }
        if self.orders_per_slot() > threshold {
            WindowSlots::One
        } else {
            WindowSlots::Two
        }
    }
}

/// The open window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowState {
    /// The window's id, as the book counts them.
    pub id: u64,
    /// Where it is in A.4's machine.
    pub phase: WindowPhase,
    /// The L2 block it opened at.
    pub opened_at_l2_block: u64,
    /// The unix second it opened at.
    pub opened_at_unix: u64,
    /// Its length in L1 slots (EC-6).
    pub slots: WindowSlots,
    /// The L2 block that carried `settleWindow`, once there is one.
    pub sync_l2_block: Option<u64>,
}

impl WindowState {
    /// A freshly opened window.
    pub fn opened(id: u64, l2_block: u64, unix: u64, slots: WindowSlots) -> Self {
        Self {
            id,
            phase: WindowPhase::Open,
            opened_at_l2_block: l2_block,
            opened_at_unix: unix,
            slots,
            sync_l2_block: None,
        }
    }

    /// Moves the window, refusing a transition A.4 does not allow.
    pub fn transition(&mut self, next: WindowPhase) -> bool {
        if !self.phase.can_transition_to(next) {
            return false;
        }
        self.phase = next;
        true
    }
}

/// The shared state store.
#[derive(Debug)]
pub struct StateStore {
    /// The deployed book's parameters, read from its immutables once the
    /// watcher has reached it (CT-12).
    pub book: Option<BookParams>,
    /// The open window.
    pub window: WindowState,
    /// Every order the settler knows about, ascending by id (SV-2).
    pub orders: BTreeMap<OrderId, TrackedOrder>,
    /// The mirror as the book holds it.
    pub mirror: MirrorState,
    /// The L1 head and the pool's live state.
    pub l1: L1Head,
    /// This window's settlement attempt (SV-3, SV-5).
    pub attempt: Attempt,
    /// CT-13's drift, per asset, read from `escrowInvariantDrift` at the L2
    /// safe head. Every entry must be zero.
    pub escrow_drift: BTreeMap<Address, i128>,
    /// The A.5 metrics.
    pub metrics: Metrics,
    /// Measured order flow (EC-6).
    pub flow: FlowMeter,
    /// Consecutive windows that failed to post. `WINDOW_HALT` halts (SV-4).
    pub unposted_windows: u32,
    /// True once the halt threshold was crossed. No settlement is submitted
    /// while halted.
    pub halted: bool,
    /// The configured window length, which the EC-6 meter may override.
    configured_slots: WindowSlots,
    /// `WINDOW_HALT`.
    window_halt: u32,
    /// `FLOW_THRESHOLD`.
    flow_threshold: f64,
}

impl StateStore {
    /// Opens the store.
    ///
    /// It opens **empty**: window state is rebuilt from L2 logs by the watcher
    /// (SV-5), not here, so that a restart and a cold start take the same path
    /// and the store itself stays free of I/O.
    pub fn open(config: &Config) -> Self {
        let mut metrics = Metrics::new();
        metrics.set(names::WINDOW_SLOTS, f64::from(config.window_slots.as_u8()));
        Self {
            book: None,
            window: WindowState::opened(0, 0, 0, config.window_slots),
            orders: BTreeMap::new(),
            mirror: MirrorState::default(),
            l1: L1Head::default(),
            attempt: Attempt::idle(0),
            escrow_drift: BTreeMap::new(),
            metrics,
            flow: FlowMeter::default(),
            unposted_windows: 0,
            halted: false,
            configured_slots: config.window_slots,
            window_halt: config.window_halt,
            flow_threshold: config.flow_threshold,
        }
    }

    /// The id of the window currently open.
    pub fn current_window(&self) -> u64 {
        self.window.id
    }

    /// The orders the book would still select, ascending by id (CT-9, SV-2).
    pub fn open_orders(&self) -> Vec<Order> {
        self.orders
            .values()
            .filter(|tracked| tracked.phase.is_open())
            .filter(|tracked| !tracked.order.is_expired(self.window.id))
            .map(|tracked| tracked.order.clone())
            .collect()
    }

    /// Opens the next window, applying the EC-6 setting at the boundary.
    ///
    /// This is the only place `WINDOW_SLOTS` changes: switching inside a window
    /// would change the length of one already being traded (EC-6).
    pub fn advance_window(&mut self, l2_block: u64, unix: u64) {
        let orders_this_window = self
            .orders
            .values()
            .filter(|tracked| tracked.order.placed_window == self.window.id)
            .count();
        self.flow.record_window(
            u32::try_from(orders_this_window).unwrap_or(u32::MAX),
            self.window.slots.as_u8(),
        );

        let slots = self
            .flow
            .desired_slots(self.flow_threshold, self.configured_slots);
        self.metrics
            .set(names::WINDOW_SLOTS, f64::from(slots.as_u8()));

        let next = self.window.id + 1;
        self.window = WindowState::opened(next, l2_block, unix, slots);
        self.attempt = Attempt::idle(next);
    }

    /// Records a window that reached a terminal outcome (A.4, A.5).
    ///
    /// A settled window clears the unposted counter; anything else advances it
    /// towards `WINDOW_HALT`, which is what halts the settler rather than
    /// letting it grind against a chain that is not accepting settlements
    /// (SV-4).
    pub fn record_outcome(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Settled => {
                self.metrics.record_window("settled");
                self.unposted_windows = 0;
            }
            Outcome::Evicted => {
                self.metrics.record_window("evicted");
                self.unposted_windows += 1;
            }
            Outcome::RolledBack => {
                self.metrics.record_window("rolled_back");
                self.unposted_windows += 1;
            }
        }
        self.metrics
            .set(names::UNPOSTED_WINDOW, f64::from(self.unposted_windows));
        if self.unposted_windows >= self.window_halt {
            self.halted = true;
        }
    }

    /// Records a window that closed with nothing to settle.
    ///
    /// An empty window is not an unposted one: nothing failed to post, there
    /// was nothing to post.
    pub fn record_empty_window(&mut self) {
        self.metrics.record_window("empty");
    }

    /// Records CT-13's drift for one asset, and publishes the worst of them as
    /// `escrow_invariant_drift_wei` — which must be zero.
    pub fn record_escrow_drift(&mut self, asset: Address, drift: i128) {
        self.escrow_drift.insert(asset, drift);
        let worst = self
            .escrow_drift
            .values()
            .copied()
            .max_by_key(|drift| drift.unsigned_abs())
            .unwrap_or(0);
        self.metrics
            .set(names::ESCROW_INVARIANT_DRIFT_WEI, worst as f64);
    }

    /// `roll_rate`: the share of tracked orders that have rolled at least once
    /// rather than filled — the cost of drift (EC-2, FE-7).
    pub fn recompute_roll_rate(&mut self) {
        let total = self.orders.len();
        if total == 0 {
            self.metrics.set(names::ROLL_RATE, 0.0);
            return;
        }
        let rolled = self
            .orders
            .values()
            .filter(|tracked| tracked.rolled_count > 0)
            .count();
        self.metrics
            .set(names::ROLL_RATE, rolled as f64 / total as f64);
    }

    /// Publishes the mirror's age at `now` (A.5, FL-1).
    pub fn record_mirror_age(&mut self, now: u64) {
        self.metrics.set(
            names::MIRROR_AGE_SLOTS,
            f64::from(self.mirror.age_slots(now)),
        );
    }

    /// The window's settlement transaction, if the front holds or held one.
    pub fn settlement_tx(&self) -> Option<B256> {
        self.attempt.tx_hash()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::testkit::{fixture_mirror, order};
    use crate::types::Side;
    use std::collections::HashMap;

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
            ("WINDOW_HALT", "2"),
            ("FLOW_THRESHOLD", "4"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        Config::from_map(&map).expect("the fixture config parses")
    }

    #[test]
    fn a4_the_window_machine_is_ix2s_table() {
        use WindowPhase::*;
        assert!(Open.can_transition_to(Settling));
        for terminal in [Settled, Evicted, RolledBack] {
            assert!(Settling.can_transition_to(terminal));
        }
        assert!(Settled.can_transition_to(RolledBack), "the demo's moment");
        assert!(Evicted.can_transition_to(Open), "orders intact");
        assert!(RolledBack.can_transition_to(Open));
        // And what the table does not allow.
        assert!(!Open.can_transition_to(Settled));
        assert!(!Settled.can_transition_to(Open));
        assert!(!Settled.can_transition_to(Evicted));
    }

    #[test]
    fn a4_the_order_machine_is_ix2s_table() {
        use OrderPhase::*;
        for next in [Selected, Rolled, Cancelled, Expired] {
            assert!(Open.can_transition_to(next));
        }
        assert!(Selected.can_transition_to(Filled));
        assert!(Selected.can_transition_to(Rolled));
        assert!(Filled.can_transition_to(Open), "a rollback undoes a fill");
        assert!(Rolled.can_transition_to(Open), "rolled is not terminal");
        assert!(!Cancelled.can_transition_to(Open), "cancelled is terminal");
        assert!(!Expired.can_transition_to(Open), "expired is terminal");
        assert!(
            !Open.can_transition_to(Filled),
            "a fill goes through selected"
        );
    }

    #[test]
    fn a4_a_roll_is_counted_and_a_disallowed_transition_is_refused() {
        let mut tracked = TrackedOrder::placed(
            order(1, Side::SellAForB, "1000000000000000000", "0"),
            10,
            1_800_000_000,
        );
        assert!(tracked.transition(OrderPhase::Selected));
        assert!(tracked.transition(OrderPhase::Rolled));
        assert_eq!(tracked.rolled_count, 1);
        assert!(tracked.transition(OrderPhase::Open));
        assert!(
            !tracked.transition(OrderPhase::Filled),
            "a fill goes through selected"
        );
        assert_eq!(tracked.phase, OrderPhase::Open);
    }

    #[test]
    fn ct9_open_orders_are_ascending_and_exclude_the_expired_and_the_closed() {
        let mut store = StateStore::open(&config());
        for id in [3u8, 1, 2] {
            let mut o = order(id, Side::SellAForB, "1000000000000000000", "0");
            o.expires_after = if id == 3 { 0 } else { 4 };
            store
                .orders
                .insert(o.id, TrackedOrder::placed(o, 1, 1_800_000_000));
        }
        store
            .orders
            .get_mut(&OrderId::with_last_byte(2))
            .unwrap()
            .transition(OrderPhase::Cancelled);
        store.window.id = 2;

        let open = store.open_orders();
        assert_eq!(
            open.iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![OrderId::with_last_byte(1)],
            "3 expired, 2 cancelled, and what remains is ascending"
        );
    }

    #[test]
    fn ec6_the_window_length_switches_at_the_boundary_on_measured_flow() {
        let mut store = StateStore::open(&config());
        assert_eq!(store.window.slots, WindowSlots::Two, "the EC-6 default");

        // A quiet window: two slots stand.
        store.advance_window(6, 1_800_000_012);
        assert_eq!(store.window.slots, WindowSlots::Two);

        // A busy one — 20 orders over two slots is 10 per slot, above the
        // threshold of 4 — drops it to one slot, at the boundary.
        for id in 1..=20u8 {
            let mut o = order(id, Side::SellAForB, "1000000000000000000", "0");
            o.placed_window = store.window.id;
            store
                .orders
                .insert(o.id, TrackedOrder::placed(o, 1, 1_800_000_000));
        }
        assert_eq!(
            store.window.slots,
            WindowSlots::Two,
            "not inside the window"
        );
        store.advance_window(12, 1_800_000_024);
        assert_eq!(store.window.slots, WindowSlots::One);
        assert_eq!(store.metrics.get(names::WINDOW_SLOTS), 1.0);
    }

    #[test]
    fn sv4_consecutive_unposted_windows_halt_the_settler() {
        let mut store = StateStore::open(&config());
        store.record_outcome(Outcome::Evicted);
        assert!(!store.halted, "one is not the threshold");
        assert_eq!(store.metrics.get(names::UNPOSTED_WINDOW), 1.0);

        store.record_outcome(Outcome::RolledBack);
        assert!(store.halted, "WINDOW_HALT=2");

        // A settlement clears the counter — the halt flag is the operator's to
        // clear, but the count is evidence and evidence moves on.
        store.record_outcome(Outcome::Settled);
        assert_eq!(store.metrics.get(names::UNPOSTED_WINDOW), 0.0);
        assert_eq!(store.metrics.window_count("settled"), 1.0);
        assert_eq!(store.metrics.window_count("evicted"), 1.0);
        assert_eq!(store.metrics.window_count("rolled_back"), 1.0);
    }

    #[test]
    fn a5_an_empty_window_is_not_an_unposted_one() {
        let mut store = StateStore::open(&config());
        store.record_empty_window();
        store.record_empty_window();
        assert!(!store.halted);
        assert_eq!(store.metrics.window_count("empty"), 2.0);
        assert_eq!(store.metrics.get(names::UNPOSTED_WINDOW), 0.0);
    }

    #[test]
    fn ct13_the_worst_drift_across_assets_is_what_is_published() {
        let mut store = StateStore::open(&config());
        store.record_escrow_drift(Address::with_last_byte(0xa0), 0);
        assert_eq!(store.metrics.get(names::ESCROW_INVARIANT_DRIFT_WEI), 0.0);
        assert!(store.metrics.violations().is_empty());

        store.record_escrow_drift(Address::with_last_byte(0xb0), -9);
        assert_eq!(store.metrics.get(names::ESCROW_INVARIANT_DRIFT_WEI), -9.0);
        assert_eq!(
            store.metrics.violations(),
            vec![names::ESCROW_INVARIANT_DRIFT_WEI]
        );
    }

    #[test]
    fn ec2_roll_rate_is_the_share_of_orders_that_have_rolled() {
        let mut store = StateStore::open(&config());
        for id in 1..=4u8 {
            let o = order(id, Side::SellAForB, "1000000000000000000", "0");
            store
                .orders
                .insert(o.id, TrackedOrder::placed(o, 1, 1_800_000_000));
        }
        let tracked = store.orders.get_mut(&OrderId::with_last_byte(1)).unwrap();
        tracked.transition(OrderPhase::Selected);
        tracked.transition(OrderPhase::Rolled);
        store.recompute_roll_rate();
        assert_eq!(store.metrics.get(names::ROLL_RATE), 0.25);
    }

    #[test]
    fn ct8_the_mirrors_age_is_published_in_whole_slots() {
        let mut store = StateStore::open(&config());
        store.mirror.state = Some(fixture_mirror());
        store.mirror.stamped_at = 1_800_000_000;
        store.record_mirror_age(1_800_000_060);
        assert_eq!(store.metrics.get(names::MIRROR_AGE_SLOTS), 5.0);
    }
}
