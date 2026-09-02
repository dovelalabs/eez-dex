//! The settlement attempt's state machine (SV-3, SV-5).
//!
//! One settlement per window, never more than one in flight, and — the part
//! that is easy to get wrong — **in-flight versus known-dropped is explicit
//! state, never inferred from a timer alone** (SV-5).
//!
//! Three things look alike from the settler's side and must not be conflated:
//!
//! * a **pinned slot skipped** by the relay, which is not poison: the front
//!   still holds the transaction and resubmitting would risk a second
//!   settlement for one window. Three consecutive relay drops evict.
//! * a **missed L1 slot**, where the framework's Sync block is empty and the
//!   window stretches. The settler waits for the next steady slot; it does not
//!   resubmit and the deadline clock is not restarted.
//! * a settlement **unseen after `DEADLINE_SECONDS`**, which is known dropped:
//!   the window is re-formed and resubmitted **once**.
//!
//! A restart rebuilds this state from L2 logs and the front's own view. An
//! attempt the front still holds is recognised by its id and reconciled, never
//! resubmitted (SV-5).

use alloy_primitives::B256;

use crate::types::OrderId;

/// Relay drops in a row that evict an attempt. A single pinned slot skipped is
/// not poison (SV-5).
pub const RELAY_DROPS_TO_EVICT: u8 = 3;

/// Why an attempt is known dropped. The two reasons are reached by different
/// evidence and both are evidence — neither is a timer firing on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// The relay reported the transaction dropped three times in a row.
    RelayEvicted,
    /// `DEADLINE_SECONDS` elapsed with the front never reporting it seen.
    DeadlineElapsed,
}

/// How a window's settlement ended (A.4, and `windows_total`'s `outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `WindowSettled` on L2, matched to an L1 receipt.
    Settled,
    /// Poison-evicted at compose time: the settlement never reached L1 and no
    /// gas was spent (FL-7).
    Evicted,
    /// The bundle was missed, reorged, or its L1 entry skipped at `postBatch`.
    RolledBack,
}

/// Where one window's settlement is.
///
/// The transitions are the whole of SV-3 and SV-5; `Attempt` below is the only
/// thing that may move between them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptState {
    /// Nothing selected yet for this window.
    Idle,
    /// A selection exists and has not been signed. One window, one selection.
    Built {
        /// The selected ids, ascending (SV-2).
        selection: Vec<OrderId>,
    },
    /// Signed and posted to the L2->L1 front, which still holds it. **Never
    /// resubmit from here** (SV-3).
    InFlight {
        /// The L2 transaction hash — how a restart recognises it (SV-5).
        tx_hash: B256,
        /// The selected ids the attempt carries.
        selection: Vec<OrderId>,
        /// The unix second it was posted at, for the deadline.
        submitted_at: u64,
        /// The leg's deadline, `sync-block timestamp + DEADLINE_SECONDS`.
        deadline: u64,
        /// Consecutive relay drops. Reset by any sighting; three evict.
        relay_drops: u8,
        /// Slots the window has stretched across because the L1 slot was
        /// missed and the Sync block was empty. Not a drop (SV-3).
        stretched_slots: u32,
        /// Whether this attempt is already the one resubmission SV-5 allows.
        is_resubmission: bool,
    },
    /// The front no longer holds it, on evidence. The window is re-formed and
    /// resubmitted **once**.
    KnownDropped {
        /// The transaction that was dropped.
        tx_hash: B256,
        /// What the settler saw.
        reason: DropReason,
        /// Whether a resubmission has already been spent.
        resubmitted_once: bool,
    },
    /// The window reached a terminal outcome.
    Resolved {
        /// The transaction it resolved through.
        tx_hash: B256,
        /// How it ended (A.4).
        outcome: Outcome,
    },
}

/// One window's settlement attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    /// The window this attempt settles.
    pub window_id: u64,
    /// Where it is.
    pub state: AttemptState,
}

impl Attempt {
    /// A window with nothing selected yet.
    pub fn idle(window_id: u64) -> Self {
        Self {
            window_id,
            state: AttemptState::Idle,
        }
    }

    /// True while the front may still hold a transaction for this window — the
    /// question SV-3's "never more than one in flight" turns on.
    pub fn is_in_flight(&self) -> bool {
        matches!(self.state, AttemptState::InFlight { .. })
    }

    /// True when a resubmission is owed: the attempt is known dropped and its
    /// one resubmission has not been spent (SV-5).
    pub fn owes_resubmission(&self) -> bool {
        matches!(
            self.state,
            AttemptState::KnownDropped {
                resubmitted_once: false,
                ..
            }
        )
    }

    /// True when the front no longer holds the transaction, on evidence —
    /// whether or not the one resubmission is still owed (SV-5).
    pub fn is_known_dropped(&self) -> bool {
        matches!(self.state, AttemptState::KnownDropped { .. })
    }

    /// True when the window has reached a terminal outcome.
    pub fn is_resolved(&self) -> bool {
        matches!(self.state, AttemptState::Resolved { .. })
    }

    /// The transaction the front holds or held, if there is one.
    pub fn tx_hash(&self) -> Option<B256> {
        match &self.state {
            AttemptState::InFlight { tx_hash, .. }
            | AttemptState::KnownDropped { tx_hash, .. }
            | AttemptState::Resolved { tx_hash, .. } => Some(*tx_hash),
            AttemptState::Idle | AttemptState::Built { .. } => None,
        }
    }

    /// The ids this attempt carries, if it carries a selection.
    pub fn selection(&self) -> &[OrderId] {
        match &self.state {
            AttemptState::Built { selection } | AttemptState::InFlight { selection, .. } => {
                selection
            }
            _ => &[],
        }
    }

    /// Records the window builder's selection. Refused while a settlement is
    /// in flight: one window, one settlement (SV-3).
    pub fn build(&mut self, selection: Vec<OrderId>) -> Result<(), AttemptError> {
        match self.state {
            AttemptState::Idle | AttemptState::Built { .. } => {
                self.state = AttemptState::Built { selection };
                Ok(())
            }
            _ => Err(AttemptError::NotBuildable),
        }
    }

    /// Records that the attempt was signed and posted to the front (SV-3).
    ///
    /// Only a built attempt, or one owed its single resubmission, may submit.
    /// Everything else is refused — this is the check that makes "never more
    /// than one in flight" a property of the type rather than of the caller.
    pub fn submit(
        &mut self,
        tx_hash: B256,
        selection: Vec<OrderId>,
        submitted_at: u64,
        deadline: u64,
    ) -> Result<(), AttemptError> {
        let is_resubmission = match &self.state {
            AttemptState::Built { .. } => false,
            AttemptState::KnownDropped {
                resubmitted_once: false,
                ..
            } => true,
            AttemptState::InFlight { .. } => return Err(AttemptError::AlreadyInFlight),
            _ => return Err(AttemptError::NotSubmittable),
        };
        self.state = AttemptState::InFlight {
            tx_hash,
            selection,
            submitted_at,
            deadline,
            relay_drops: 0,
            stretched_slots: 0,
            is_resubmission,
        };
        Ok(())
    }

    /// The front reported the transaction still held. Clears the drop counter:
    /// only *consecutive* drops evict (SV-5).
    pub fn note_seen(&mut self) {
        if let AttemptState::InFlight { relay_drops, .. } = &mut self.state {
            *relay_drops = 0;
        }
    }

    /// The relay reported the transaction dropped from a pinned slot.
    ///
    /// One is not poison. Three in a row evict, and the attempt becomes known
    /// dropped — explicit state, on evidence (SV-5).
    pub fn note_relay_drop(&mut self) {
        let AttemptState::InFlight {
            tx_hash,
            relay_drops,
            is_resubmission,
            ..
        } = &mut self.state
        else {
            return;
        };
        *relay_drops += 1;
        if *relay_drops >= RELAY_DROPS_TO_EVICT {
            self.state = AttemptState::KnownDropped {
                tx_hash: *tx_hash,
                reason: DropReason::RelayEvicted,
                resubmitted_once: *is_resubmission,
            };
        }
    }

    /// The L1 slot was missed, so the framework's Sync block is empty and the
    /// window stretches.
    ///
    /// This is **not** a drop and **not** a reason to resubmit: the settler
    /// waits for the next steady slot (SV-3). The deadline is not extended
    /// either — it is checked on L1, where time is real.
    pub fn note_missed_slot(&mut self) {
        if let AttemptState::InFlight {
            stretched_slots,
            relay_drops,
            ..
        } = &mut self.state
        {
            *stretched_slots += 1;
            *relay_drops = 0;
        }
    }

    /// `now` has passed the leg's deadline without the front reporting the
    /// transaction seen, so it is known dropped (SV-5).
    ///
    /// The deadline is evidence, not a guess: past it the leg would revert
    /// `Expired` on L1 (CT-1), so the transaction cannot settle even if the
    /// front still holds it.
    pub fn note_deadline(&mut self, now: u64) {
        let AttemptState::InFlight {
            tx_hash,
            deadline,
            is_resubmission,
            ..
        } = &self.state
        else {
            return;
        };
        if now > *deadline {
            self.state = AttemptState::KnownDropped {
                tx_hash: *tx_hash,
                reason: DropReason::DeadlineElapsed,
                resubmitted_once: *is_resubmission,
            };
        }
    }

    /// The window's outcome became known (SV-4).
    pub fn resolve(&mut self, outcome: Outcome) {
        let tx_hash = self.tx_hash().unwrap_or_default();
        self.state = AttemptState::Resolved { tx_hash, outcome };
    }

    /// Re-forms the window after a failure: the orders are intact and open,
    /// and the next selection starts from nothing (A.4, SV-4).
    pub fn reform(&mut self) {
        self.state = AttemptState::Idle;
    }

    /// Marks the one resubmission SV-5 allows as spent without taking it —
    /// what a settler does when the window it would resubmit into has already
    /// moved on.
    pub fn abandon(&mut self) {
        if let AttemptState::KnownDropped {
            resubmitted_once, ..
        } = &mut self.state
        {
            *resubmitted_once = true;
        }
    }
}

/// Why a transition was refused. Every variant is a settlement that would have
/// been a second one for the same window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AttemptError {
    /// A settlement is in flight; the front still holds it (SV-3).
    #[error("a settlement for this window is already in flight")]
    AlreadyInFlight,
    /// The attempt is resolved, or dropped with its resubmission spent.
    #[error("this window's attempt cannot be submitted")]
    NotSubmittable,
    /// A selection cannot be recorded from this state.
    #[error("this window's attempt cannot take a new selection")]
    NotBuildable,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: u8) -> Vec<OrderId> {
        (1..=n).map(OrderId::with_last_byte).collect()
    }

    fn in_flight() -> Attempt {
        let mut attempt = Attempt::idle(7);
        attempt.build(ids(3)).unwrap();
        attempt
            .submit(
                B256::repeat_byte(0xaa),
                ids(3),
                1_800_000_000,
                1_800_000_024,
            )
            .unwrap();
        attempt
    }

    #[test]
    fn sv3_one_settlement_per_window_and_never_two_in_flight() {
        let mut attempt = in_flight();
        assert!(attempt.is_in_flight());
        assert_eq!(
            attempt.submit(
                B256::repeat_byte(0xbb),
                ids(3),
                1_800_000_001,
                1_800_000_025
            ),
            Err(AttemptError::AlreadyInFlight)
        );
        // And a new selection cannot displace one the front holds.
        assert_eq!(attempt.build(ids(2)), Err(AttemptError::NotBuildable));
    }

    #[test]
    fn sv5_one_relay_drop_is_not_poison_and_a_sighting_clears_the_count() {
        let mut attempt = in_flight();
        attempt.note_relay_drop();
        attempt.note_relay_drop();
        assert!(attempt.is_in_flight(), "two drops are not three");

        attempt.note_seen();
        attempt.note_relay_drop();
        attempt.note_relay_drop();
        assert!(
            attempt.is_in_flight(),
            "the counter is consecutive drops, not drops ever"
        );

        attempt.note_relay_drop();
        assert!(matches!(
            attempt.state,
            AttemptState::KnownDropped {
                reason: DropReason::RelayEvicted,
                ..
            }
        ));
    }

    #[test]
    fn sv3_a_missed_l1_slot_stretches_the_window_and_never_resubmits() {
        let mut attempt = in_flight();
        attempt.note_relay_drop();
        attempt.note_relay_drop();
        attempt.note_missed_slot();
        attempt.note_missed_slot();

        assert!(
            attempt.is_in_flight(),
            "the window stretches, it does not evict"
        );
        assert!(!attempt.owes_resubmission());
        let AttemptState::InFlight {
            stretched_slots,
            relay_drops,
            ..
        } = attempt.state
        else {
            panic!("still in flight")
        };
        assert_eq!(stretched_slots, 2);
        assert_eq!(relay_drops, 0, "an empty Sync block is not a drop");
    }

    #[test]
    fn sv5_in_flight_versus_known_dropped_is_state_not_a_timer() {
        let mut attempt = in_flight();
        // Before the deadline the attempt stays in flight however long it has
        // been: elapsed time on its own is not evidence.
        attempt.note_deadline(1_800_000_023);
        assert!(attempt.is_in_flight());

        attempt.note_deadline(1_800_000_025);
        assert_eq!(
            attempt.state,
            AttemptState::KnownDropped {
                tx_hash: B256::repeat_byte(0xaa),
                reason: DropReason::DeadlineElapsed,
                resubmitted_once: false,
            }
        );
    }

    #[test]
    fn sv5_a_dropped_window_is_resubmitted_exactly_once() {
        let mut attempt = in_flight();
        attempt.note_deadline(1_800_000_025);
        assert!(attempt.owes_resubmission());

        attempt
            .submit(
                B256::repeat_byte(0xbb),
                ids(3),
                1_800_000_026,
                1_800_000_050,
            )
            .unwrap();
        assert!(attempt.is_in_flight());

        // The resubmission is dropped too. There is no third attempt.
        attempt.note_deadline(1_800_000_051);
        assert!(
            !attempt.owes_resubmission(),
            "one resubmission, not a retry loop"
        );
        assert_eq!(
            attempt.submit(
                B256::repeat_byte(0xcc),
                ids(3),
                1_800_000_052,
                1_800_000_076
            ),
            Err(AttemptError::NotSubmittable)
        );
    }

    #[test]
    fn sv5_a_restart_recognises_an_attempt_by_its_id_rather_than_resubmitting() {
        let attempt = in_flight();
        // What survives a restart is the id and the state, and the state says
        // the front holds it — so the settler reconciles, never resubmits.
        assert_eq!(attempt.tx_hash(), Some(B256::repeat_byte(0xaa)));
        assert!(attempt.is_in_flight());
        assert!(!attempt.owes_resubmission());
        assert_eq!(attempt.selection(), ids(3));
    }

    #[test]
    fn a4_a_failed_window_re_forms_with_its_orders_intact() {
        let mut attempt = in_flight();
        attempt.resolve(Outcome::Evicted);
        assert!(attempt.is_resolved());
        assert!(!attempt.is_in_flight());

        attempt.reform();
        assert_eq!(attempt.state, AttemptState::Idle);
        attempt.build(ids(2)).unwrap();
        assert_eq!(attempt.selection(), ids(2));
    }

    #[test]
    fn sv5_an_abandoned_drop_spends_its_resubmission_without_taking_it() {
        let mut attempt = in_flight();
        attempt.note_deadline(1_800_000_025);
        attempt.abandon();
        assert!(!attempt.owes_resubmission());
        assert_eq!(
            attempt.submit(
                B256::repeat_byte(0xbb),
                ids(3),
                1_800_000_026,
                1_800_000_050
            ),
            Err(AttemptError::NotSubmittable)
        );
    }

    #[test]
    fn sv3_nothing_moves_a_state_that_holds_no_transaction() {
        let mut attempt = Attempt::idle(1);
        attempt.note_relay_drop();
        attempt.note_missed_slot();
        attempt.note_deadline(u64::MAX);
        attempt.note_seen();
        assert_eq!(attempt.state, AttemptState::Idle);
        assert_eq!(attempt.tx_hash(), None);
        assert!(attempt.selection().is_empty());
    }
}
