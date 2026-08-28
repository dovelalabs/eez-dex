//! Reconciler — outcome, audit, invariant, halt (SV-4, EC-4).
//!
//! It matches `WindowSettled` to the L1 receipt, reading L2 at `safe` for
//! operations and `finalized` for accounting, and distinguishes three failures
//! that look alike from L2:
//!
//! * **poison eviction** — the settlement never reached L1. No gas (FL-7).
//! * **rollback** — the bundle was not included, or was included and then
//!   reorged. Different framework paths, the same L2 observable: blocks
//!   un-happen and events go non-canonical.
//! * the **`postBatch` skip** — the L1 entry reverted at inclusion, the batch
//!   landed without it, and the framework rolled the Sync block back. This is
//!   a rollback, **not** an eviction, and **L1 gas was spent**. Recording it as
//!   free would make the one failure that costs money invisible.
//!
//! It also audits the settler that produced the selection: recomputing the
//! inclusion-maximal set from the settled `P0` and reporting any fillable order
//! that was left out as `selection_omitted_total`, which must be zero (EC-4).
//! That metric is the on-chain-observable check on the settler's fairness —
//! the reason settlement can be a permissioned role without being a custodial
//! one.

use alloy_primitives::{B256, U256};

use crate::attempt::Outcome;
use crate::chain::{BookEvent, Front, FrontStatus, L1Reader, L1Receipt, L2Reader};
use crate::config::{Config, metrics as names};
use crate::math;
use crate::selection::{MirrorSimulator, SelectionInputs, select_fillable};
use crate::state::{OrderPhase, StateStore, WindowPhase};
use crate::types::{OrderId, PoolState, WindowResult};
use crate::{Task, TaskError};

/// What L2 says about the settlement transaction (SV-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum L2Observation {
    /// It was never included in an L2 block.
    NotIncluded,
    /// It is in a canonical block and `WindowSettled` stands.
    Canonical,
    /// It was included and its block has un-happened; the event is
    /// non-canonical.
    NonCanonical,
}

/// What L1 says about the batch entry that carried it (SV-4).
///
/// The frame is atomic: a canonical `WindowSettled` on L2 already means the L1
/// leg executed (A.2). The receipt is what the window *cost*, not whether it
/// happened — except for `EntryReverted`, which is the one thing L2 cannot say
/// for itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum L1Observation {
    /// No receipt found for the leg's L1 block. Nothing is known about gas.
    NoEntry,
    /// The entry executed. Its receipt carries the gas the window cost.
    EntryExecuted(L1Receipt),
    /// The entry reverted at inclusion and the batch landed without it — the
    /// `postBatch` skip. **Gas was spent.**
    EntryReverted(L1Receipt),
}

/// Why a settled window was rolled back — IX-2's `RollbackCause`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackCause {
    /// The bundle was never posted.
    BundleMissed,
    /// It was posted and then the L1 block that carried it was reorged.
    Reorg,
    /// The L1 entry reverted at inclusion; the batch landed without it.
    PostbatchSkip,
}

impl RollbackCause {
    /// The IX-2 wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BundleMissed => "bundle_missed",
            Self::Reorg => "reorg",
            Self::PostbatchSkip => "postbatch_skip",
        }
    }
}

/// Everything the classification turns on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementObservation {
    /// What L2 says.
    pub l2: L2Observation,
    /// What L1 says.
    pub l1: L1Observation,
    /// Whether the settler ever saw this settlement canonical. It is what
    /// separates a bundle that was never posted from one that was posted and
    /// then reorged — the same L2 observable, two framework paths.
    pub was_canonical: bool,
    /// Whether the leg's deadline has passed. Before it, a settlement the
    /// front still holds is simply in flight (SV-5).
    pub deadline_passed: bool,
}

/// How a window ended, and what it cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolution {
    /// The A.4 outcome.
    pub outcome: Outcome,
    /// Why, when it rolled back.
    pub cause: Option<RollbackCause>,
    /// True when L1 gas was spent despite the window not settling — the one
    /// rollback that is not free (SV-4).
    pub l1_gas_spent: bool,
    /// The L1 receipt, where there is one.
    pub receipt: Option<L1Receipt>,
}

/// Classifies one settlement's outcome — the whole of SV-4's distinction, as a
/// pure function.
///
/// `None` means *not yet*: the settlement is still in flight and nothing has
/// happened that resolves it either way. Guessing here is exactly the mistake
/// SV-5 forbids — in-flight versus dropped is state on evidence, never a timer.
pub fn classify(observation: &SettlementObservation) -> Option<Resolution> {
    let receipt = match observation.l1 {
        L1Observation::NoEntry => None,
        L1Observation::EntryExecuted(receipt) | L1Observation::EntryReverted(receipt) => {
            Some(receipt)
        }
    };

    // The `postBatch` skip comes first because it is the one case L2 cannot
    // tell apart from an ordinary rollback, and the only one that cost money.
    if matches!(observation.l1, L1Observation::EntryReverted(_)) {
        return Some(Resolution {
            outcome: Outcome::RolledBack,
            cause: Some(RollbackCause::PostbatchSkip),
            l1_gas_spent: true,
            receipt,
        });
    }

    match observation.l2 {
        // A canonical `WindowSettled` is the window settling: the frame is
        // atomic, so the event's existence in a canonical block already means
        // the L1 leg ran (A.2). The receipt adds what it cost, when it is in.
        L2Observation::Canonical => Some(Resolution {
            outcome: Outcome::Settled,
            cause: None,
            l1_gas_spent: true,
            receipt,
        }),

        // The L2 blocks un-happened. Whether the bundle was never posted or was
        // posted and then reorged is the same observable from L2; what
        // separates them is whether the settler ever saw it land.
        L2Observation::NonCanonical => Some(Resolution {
            outcome: Outcome::RolledBack,
            cause: Some(if observation.was_canonical {
                RollbackCause::Reorg
            } else {
                RollbackCause::BundleMissed
            }),
            l1_gas_spent: receipt.is_some(),
            receipt,
        }),

        // Never included anywhere, past its deadline: poison-evicted at compose
        // time. No mainnet gas, no partial fills, escrow untouched (FL-7).
        L2Observation::NotIncluded if observation.deadline_passed => Some(Resolution {
            outcome: Outcome::Evicted,
            cause: None,
            l1_gas_spent: false,
            receipt: None,
        }),

        // Still on its way.
        L2Observation::NotIncluded => None,
    }
}

/// Fillable orders the settler omitted from a settled window (EC-4).
///
/// The audit recomputes the inclusion-maximal set **from the settled `P0`**:
/// the pool as the leg found it is reconstructed from the reference price the
/// leg returned, the selection loop is run again over the orders that were open,
/// and anything it would have filled that the settler left out is reported.
///
/// It is deliberately the same loop, not a second implementation of it. What is
/// being audited is the settler's *inputs and honesty*, not its arithmetic —
/// the arithmetic the contract re-derives for itself (CT-9, CT-10).
pub fn audit_selection(
    state: &StateStore,
    result: &WindowResult,
    submitted: &[OrderId],
    deadline: u64,
) -> Vec<OrderId> {
    let (Some(params), Some(mirror_state)) = (state.book.as_ref(), state.mirror.state.as_ref())
    else {
        return Vec::new();
    };
    if result.reference_price_x96.is_zero() {
        return Vec::new();
    }

    // The pool as the leg found it: `P0` was read in-leg immediately before the
    // swap, so a snapshot at that price with the post-trade depth is the head
    // the settler should have selected against.
    let head = PoolState {
        sqrt_price_x96: math::sqrt_price_from_price_x96(result.reference_price_x96),
        liquidity: result.post.liquidity,
        tick: result.post.tick,
    };

    let recomputed = select_fillable(
        &state.open_orders(),
        SelectionInputs {
            params,
            mirror: mirror_state,
            window_id: state.window.id,
            deadline,
        },
        &MirrorSimulator {
            head,
            l1_block: result.l1_block,
            l1_timestamp: deadline.saturating_sub(1),
        },
    );

    recomputed
        .selected
        .into_iter()
        .filter(|id| !submitted.contains(id))
        .collect()
}

/// Matches settlements to their outcome and audits the selection.
#[derive(Debug)]
pub struct Reconciler<R2, R1, F> {
    l2: R2,
    l1: R1,
    front: F,
    /// Whether the settler has seen this attempt canonical at least once.
    was_canonical: bool,
    /// The counterfactual per fill: what the same fills would have cost as
    /// direct L1 swaps (IX-3's ER-2 baseline, ~400k gas).
    counterfactual_gas_per_swap: u64,
}

/// ER-2's median retail swap gas — the counterfactual IX-3 falls back to when
/// the user's own last L1 swap is not observable.
pub const COUNTERFACTUAL_SWAP_GAS: u64 = 400_000;

impl<R2: L2Reader, R1: L1Reader, F: Front> Reconciler<R2, R1, F> {
    /// Builds the reconciler from a validated configuration.
    pub fn new(_config: &Config, l2: R2, l1: R1, front: F) -> Self {
        Self {
            l2,
            l1,
            front,
            was_canonical: false,
            counterfactual_gas_per_swap: COUNTERFACTUAL_SWAP_GAS,
        }
    }

    /// Reads the two chains and the front for what they say about `tx_hash`.
    fn observe(
        &mut self,
        state: &StateStore,
        tx_hash: B256,
        settled: Option<&BookEvent>,
    ) -> Result<SettlementObservation, TaskError> {
        let status = self.front.status(tx_hash)?;
        let l2 = match status {
            // The front still holds it, so no L2 block carries it yet.
            FrontStatus::Held | FrontStatus::Dropped => L2Observation::NotIncluded,
            FrontStatus::Included { .. } => {
                if self.l2.is_canonical(tx_hash)? {
                    self.was_canonical = true;
                    L2Observation::Canonical
                } else {
                    L2Observation::NonCanonical
                }
            }
        };

        // The L1 entry that carried it. `WindowResult.l1Block` is what names
        // the block, so without the event there is nothing to look up.
        let l1 = match settled {
            Some(BookEvent::Settled { result, .. }) => {
                match self.l1.entry_receipt(result.l1_block)? {
                    Some(receipt) if receipt.success => L1Observation::EntryExecuted(receipt),
                    Some(receipt) => L1Observation::EntryReverted(receipt),
                    None => L1Observation::NoEntry,
                }
            }
            _ => L1Observation::NoEntry,
        };

        Ok(SettlementObservation {
            l2,
            l1,
            was_canonical: self.was_canonical,
            deadline_passed: state.l1.timestamp > state.attempt_deadline().unwrap_or(u64::MAX),
        })
    }

    /// Records everything one settled window earns in metrics (A.5, IX-3).
    fn record_settled(
        &self,
        state: &mut StateStore,
        result: &WindowResult,
        receipt: &L1Receipt,
        selected: &[OrderId],
    ) {
        let fills = selected
            .iter()
            .filter(|id| state.orders.contains_key(*id))
            .count();
        let fills_f64 = fills as f64;
        state
            .metrics
            .observe(names::FILLS_PER_SETTLEMENT, fills_f64);

        if fills > 0 {
            let gas_per_fill = receipt.gas_cost_wei as f64 / fills_f64;
            state.metrics.observe(names::GAS_PER_FILL_WEI, gas_per_fill);
            // IX-3's counterfactual: the same fills as direct L1 swaps, at the
            // ER-2 median rather than a fixed single-hop estimate.
            let counterfactual =
                f64::from(u32::try_from(self.counterfactual_gas_per_swap).unwrap_or(u32::MAX))
                    * receipt.effective_gas_price_wei as f64;
            state
                .metrics
                .observe(names::COUNTERFACTUAL_L1_GAS_WEI, counterfactual);
        }

        // `impact_bps`: how far the realised average fell from `P0`. The
        // residual side alone bore it (FL-5).
        state.metrics.observe(names::IMPACT_BPS, impact_bps(result));

        // Order placement to settlement, in seconds.
        let now = state.l2_safe.timestamp;
        let oldest = selected
            .iter()
            .filter_map(|id| state.orders.get(id))
            .map(|tracked| tracked.placed_at_unix)
            .min();
        if let Some(placed) = oldest {
            state.metrics.observe(
                names::TIME_TO_SETTLE_SECONDS,
                now.saturating_sub(placed) as f64,
            );
        }
    }

    /// Re-forms the window after a failure: every order is intact and open
    /// again, and the next selection starts from nothing (A.4, SV-4).
    ///
    /// `selected` is taken before the attempt resolves, because a resolved
    /// attempt no longer carries one — and the orders that must be re-opened
    /// are exactly the ones it was carrying.
    fn reform(&self, state: &mut StateStore, selected: &[OrderId]) {
        for id in selected {
            if let Some(tracked) = state.orders.get_mut(id) {
                tracked.transition(OrderPhase::Open);
            }
        }
        state.attempt.reform();
        state.selection = None;
    }
}

impl<R2: L2Reader, R1: L1Reader, F: Front> Task for Reconciler<R2, R1, F> {
    fn name(&self) -> &'static str {
        "reconciler"
    }

    fn tick(&mut self, state: &mut StateStore) -> Result<(), TaskError> {
        let Some(tx_hash) = state.attempt.tx_hash() else {
            return Ok(());
        };
        if state.attempt.is_resolved() {
            return Ok(());
        }
        // The window's selection, taken before anything below can move the
        // attempt out of a state that carries one. These are the orders a
        // failure has to re-open and a success has to audit.
        let selected: Vec<OrderId> = state.attempt.selection().to_vec();

        // Accounting reads `finalized`; operations read `safe` (SV-4). The
        // finalized head is what makes an outcome final rather than revocable.
        let finalized = self.l2.finalized_head()?;
        let settled = state
            .observed_settlements
            .iter()
            .find(|event| matches!(event, BookEvent::Settled { tx_hash: hash, .. } if *hash == tx_hash))
            .cloned();

        let observation = self.observe(state, tx_hash, settled.as_ref())?;

        // The front's own view drives the attempt machine. One dropped reading
        // is not eviction — a pinned slot skipped looks exactly like it (SV-5).
        match self.front.status(tx_hash)? {
            FrontStatus::Held => state.attempt.note_seen(),
            FrontStatus::Dropped => state.attempt.note_relay_drop(),
            FrontStatus::Included { .. } => state.attempt.note_seen(),
        }
        state.attempt.note_deadline(state.l1.timestamp);

        let Some(resolution) = classify(&observation) else {
            return Ok(());
        };

        match resolution.outcome {
            Outcome::Settled => {
                state.window.transition(WindowPhase::Settled);
                if let Some(BookEvent::Settled { result, .. }) = &settled {
                    if let Some(receipt) = &resolution.receipt {
                        self.record_settled(state, result, receipt, &selected);
                    }
                    // EC-4: recompute the inclusion-maximal set from the
                    // settled `P0` and report anything fillable left out. It
                    // must be zero; it is the check that makes a permissioned
                    // settler's fairness observable on-chain.
                    let deadline = state.attempt_deadline().unwrap_or(state.l1.timestamp);
                    let omitted = audit_selection(state, result, &selected, deadline);
                    if !omitted.is_empty() {
                        state
                            .metrics
                            .increment(names::SELECTION_OMITTED_TOTAL, omitted.len() as f64);
                        state.omitted_orders.extend(omitted);
                    }
                }
                state.attempt.resolve(Outcome::Settled);
                state.record_outcome(Outcome::Settled);
            }
            Outcome::Evicted => {
                state.window.transition(WindowPhase::Evicted);
                state.attempt.resolve(Outcome::Evicted);
                state.record_outcome(Outcome::Evicted);
                self.reform(state, &selected);
            }
            Outcome::RolledBack => {
                state.window.transition(WindowPhase::RolledBack);
                if resolution.l1_gas_spent {
                    // The `postBatch` skip: the window did not settle and L1
                    // gas was still spent. Recording it is the point (SV-4).
                    if let Some(receipt) = &resolution.receipt {
                        state
                            .metrics
                            .observe(names::GAS_PER_FILL_WEI, receipt.gas_cost_wei as f64);
                    }
                }
                state.rollback_cause = resolution.cause;
                state.attempt.resolve(Outcome::RolledBack);
                state.record_outcome(Outcome::RolledBack);
                self.reform(state, &selected);
            }
        }

        state.record_mirror_age(finalized.timestamp.max(state.l2_safe.timestamp));
        state.recompute_roll_rate();
        Ok(())
    }
}

/// The impact a settled leg realised, in basis points (A.5, FL-5).
pub fn impact_bps(result: &WindowResult) -> f64 {
    if result.reference_price_x96.is_zero() {
        return 0.0;
    }
    let p0 = result.reference_price_x96;
    let executed = result.execution_price_x96;
    let gap = if p0 > executed {
        p0 - executed
    } else {
        executed - p0
    };
    math::mul_div(gap, U256::from(10_000u16), p0)
        .map(f64::from)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::WindowBuilder;
    use crate::chain::HeadInfo;
    use crate::submitter::Submitter;
    use crate::testkit::{
        FakeFront, FakeL1, FakeL2, FakeSigner, fixture_config, fixture_mirror, order, store,
    };
    use crate::types::Side;
    use crate::watcher::Watcher;

    fn receipt(block: u64, success: bool) -> L1Receipt {
        L1Receipt {
            tx_hash: B256::repeat_byte(0xf1),
            block_number: block,
            gas_used: 210_000,
            effective_gas_price_wei: 1_000_000_000,
            gas_cost_wei: 210_000 * 1_000_000_000,
            success,
        }
    }

    fn observation(l2: L2Observation, l1: L1Observation) -> SettlementObservation {
        SettlementObservation {
            l2,
            l1,
            was_canonical: false,
            deadline_passed: false,
        }
    }

    // --- SV-4's three failures, as a table ----------------------------------

    #[test]
    fn fl7_a_settlement_that_never_reached_l1_is_a_free_eviction() {
        let mut seen = observation(L2Observation::NotIncluded, L1Observation::NoEntry);
        assert_eq!(classify(&seen), None, "before the deadline it is in flight");

        seen.deadline_passed = true;
        let resolution = classify(&seen).unwrap();
        assert_eq!(resolution.outcome, Outcome::Evicted);
        assert!(!resolution.l1_gas_spent, "poison eviction costs nothing");
        assert_eq!(resolution.receipt, None);
    }

    #[test]
    fn sv4_a_canonical_window_settled_is_the_window_settling() {
        let resolution = classify(&observation(
            L2Observation::Canonical,
            L1Observation::EntryExecuted(receipt(5, true)),
        ))
        .unwrap();
        assert_eq!(resolution.outcome, Outcome::Settled);
        assert_eq!(resolution.cause, None);
        assert_eq!(resolution.receipt.unwrap().gas_used, 210_000);
    }

    #[test]
    fn sv4_a_bundle_never_posted_and_one_reorged_are_told_apart_by_history() {
        let mut seen = observation(L2Observation::NonCanonical, L1Observation::NoEntry);
        let missed = classify(&seen).unwrap();
        assert_eq!(missed.outcome, Outcome::RolledBack);
        assert_eq!(missed.cause, Some(RollbackCause::BundleMissed));
        assert!(!missed.l1_gas_spent);

        // The settler saw it land, and then it un-happened.
        seen.was_canonical = true;
        let reorged = classify(&seen).unwrap();
        assert_eq!(reorged.cause, Some(RollbackCause::Reorg));
        assert!(
            !reorged.l1_gas_spent,
            "a reorg refunds nothing but spends nothing here"
        );
    }

    #[test]
    fn sv4_the_postbatch_skip_is_a_rollback_that_spent_l1_gas() {
        // The L1 entry reverted at inclusion, the batch landed without it, and
        // the framework rolled the Sync block back. It is not an eviction, and
        // recording it as free would hide the one failure that costs money.
        for l2 in [
            L2Observation::Canonical,
            L2Observation::NonCanonical,
            L2Observation::NotIncluded,
        ] {
            let resolution = classify(&observation(
                l2,
                L1Observation::EntryReverted(receipt(9, false)),
            ))
            .unwrap();
            assert_eq!(resolution.outcome, Outcome::RolledBack);
            assert_eq!(resolution.cause, Some(RollbackCause::PostbatchSkip));
            assert!(resolution.l1_gas_spent, "L1 gas *was* spent");
            assert_eq!(resolution.receipt.unwrap().block_number, 9);
        }
    }

    #[test]
    fn ix2_the_rollback_causes_carry_their_wire_names() {
        assert_eq!(RollbackCause::BundleMissed.as_str(), "bundle_missed");
        assert_eq!(RollbackCause::Reorg.as_str(), "reorg");
        assert_eq!(RollbackCause::PostbatchSkip.as_str(), "postbatch_skip");
    }

    // --- the whole loop, over the fakes -------------------------------------

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

    /// Drives watcher, builder and submitter to a window with one settlement in
    /// flight, and returns everything needed to reconcile it.
    fn settled_window(orders: Vec<crate::types::Order>) -> (StateStore, FakeL2, FakeL1, FakeFront) {
        let l1 = FakeL1::at(2000);
        let l2 = FakeL2::new();
        l2.set_window(0, 1, 0, fixture_mirror(), 1_800_000_000);
        l2.set_open_orders(orders);
        l2.set_safe_block(6);
        let front = FakeFront::new();

        let mut state = store();
        Watcher::new(l2.clone(), l1.clone(), 0)
            .tick(&mut state)
            .unwrap();
        WindowBuilder::new(&fixture_config(), l1.simulator())
            .tick(&mut state)
            .unwrap();
        Submitter::new(&fixture_config(), l2.clone(), front.clone(), FakeSigner)
            .tick(&mut state)
            .unwrap();
        (state, l2, l1, front)
    }

    /// Puts a canonical `WindowSettled` for the in-flight attempt into the
    /// store, as the watcher would have.
    fn record_settlement(
        state: &mut StateStore,
        l2: &FakeL2,
        front: &FakeFront,
        l1: &FakeL1,
        l1_block: u64,
    ) -> WindowResult {
        let tx_hash = state.attempt.tx_hash().unwrap();
        let evaluation = state
            .selection
            .as_ref()
            .unwrap()
            .evaluation
            .as_ref()
            .unwrap();
        let result = evaluation.result;
        let result = WindowResult { l1_block, ..result };

        state.observed_settlements.push(BookEvent::Settled {
            window_id: state.window.id,
            result,
            tx_hash,
            l2_block: 6,
            unix: 1_800_000_012,
        });
        front.set_status(tx_hash, crate::chain::FrontStatus::Included { l2_block: 6 });
        l2.set_canonical(tx_hash, true);
        l1.set_entry_receipt(l1_block, receipt(l1_block, true));
        result
    }

    fn reconciler(
        l2: &FakeL2,
        l1: &FakeL1,
        front: &FakeFront,
    ) -> Reconciler<FakeL2, FakeL1, FakeFront> {
        Reconciler::new(&fixture_config(), l2.clone(), l1.clone(), front.clone())
    }

    #[test]
    fn sv4_a_settled_window_records_its_amortisation() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        record_settlement(&mut state, &l2, &front, &l1, 1_001);

        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert_eq!(state.window.phase, WindowPhase::Settled);
        assert_eq!(state.metrics.window_count("settled"), 1.0);
        assert_eq!(state.metrics.get(names::FILLS_PER_SETTLEMENT), 2.0);
        // Two fills over one cross-layer transaction: gas per fill is half.
        assert_eq!(
            state.metrics.get(names::GAS_PER_FILL_WEI),
            (210_000.0 * 1_000_000_000.0) / 2.0
        );
        assert!(state.metrics.get(names::COUNTERFACTUAL_L1_GAS_WEI) > 0.0);
        assert!(
            state.metrics.get(names::COUNTERFACTUAL_L1_GAS_WEI)
                > state.metrics.get(names::GAS_PER_FILL_WEI),
            "amortisation is real: one L1 transaction beats two"
        );
        assert_eq!(state.metrics.get(names::UNPOSTED_WINDOW), 0.0);
    }

    #[test]
    fn ec4_a_settled_window_leaves_selection_omitted_total_at_zero() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        record_settlement(&mut state, &l2, &front, &l1, 1_001);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert_eq!(state.metrics.get(names::SELECTION_OMITTED_TOTAL), 0.0);
        assert!(state.omitted_orders.is_empty());
        assert!(state.metrics.violations().is_empty());
    }

    #[test]
    fn adversarial_settler_is_detected() {
        // EC-4 / TS-3: a settler that omits fillable orders is caught by the
        // reconciler's audit, which recomputes the inclusion-maximal set from
        // the settled `P0` and reports what was left out.
        let (mut state, l2, l1, front) = settled_window(two_orders());
        let full_selection = state.attempt.selection().to_vec();
        assert_eq!(full_selection.len(), 2);

        let result = record_settlement(&mut state, &l2, &front, &l1, 1_001);

        // The adversary settled only the first of the two fillable orders.
        let omitted = audit_selection(&state, &result, &full_selection[..1], 1_800_000_036);
        assert_eq!(
            omitted,
            vec![full_selection[1]],
            "the order the settler starved must be named"
        );

        // And an honest settlement names nobody.
        assert!(audit_selection(&state, &result, &full_selection, 1_800_000_036).is_empty());
    }

    #[test]
    fn ec4_the_audit_raises_selection_omitted_total_through_the_reconciler() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        let full = state.attempt.selection().to_vec();
        record_settlement(&mut state, &l2, &front, &l1, 1_001);

        // Rewrite the attempt to the adversary's half-selection, keeping the
        // transaction that is in flight.
        let tx_hash = state.attempt.tx_hash().unwrap();
        state.attempt.reform();
        state.attempt.build(full[..1].to_vec()).unwrap();
        state
            .attempt
            .submit(tx_hash, full[..1].to_vec(), 1_800_000_000, 1_800_000_036)
            .unwrap();

        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert_eq!(state.metrics.get(names::SELECTION_OMITTED_TOTAL), 1.0);
        assert_eq!(state.omitted_orders, vec![full[1]]);
        assert_eq!(
            state.metrics.violations(),
            vec![names::SELECTION_OMITTED_TOTAL],
            "the metric that must be zero is not"
        );
    }

    #[test]
    fn sv4_an_evicted_window_re_forms_with_its_orders_open() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        let selected = state.attempt.selection().to_vec();
        let tx_hash = state.attempt.tx_hash().unwrap();
        front.set_status(tx_hash, crate::chain::FrontStatus::Dropped);
        state.l1.timestamp = 1_800_000_100; // past the deadline

        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert_eq!(state.window.phase, WindowPhase::Evicted);
        assert_eq!(state.metrics.window_count("evicted"), 1.0);
        assert_eq!(state.metrics.get(names::UNPOSTED_WINDOW), 1.0);
        for id in &selected {
            assert_eq!(
                state.orders[id].phase,
                OrderPhase::Open,
                "every order is intact and open again (A.4, FL-7)"
            );
        }
        assert!(state.selection.is_none(), "the window re-formed");
    }

    #[test]
    fn sv4_the_settler_halts_on_the_unposted_window_threshold() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        let tx_hash = state.attempt.tx_hash().unwrap();
        front.set_status(tx_hash, crate::chain::FrontStatus::Dropped);
        state.l1.timestamp = 1_800_000_100;
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        assert!(!state.halted, "one unposted window is not the threshold");

        // A second, on a fresh attempt for the same store.
        state.attempt.reform();
        state
            .attempt
            .build(vec![crate::types::OrderId::with_last_byte(1)])
            .unwrap();
        state
            .attempt
            .submit(
                B256::repeat_byte(0xbb),
                vec![],
                1_800_000_000,
                1_800_000_010,
            )
            .unwrap();
        front.set_default_status(crate::chain::FrontStatus::Dropped);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert!(state.halted, "WINDOW_HALT=2");
        assert_eq!(state.metrics.get(names::UNPOSTED_WINDOW), 2.0);
    }

    #[test]
    fn sv5_a_settlement_the_front_holds_is_reconciled_not_resolved() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        // The front holds it and the deadline has not passed.
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert!(state.attempt.is_in_flight(), "nothing has resolved it");
        assert_eq!(state.window.phase, WindowPhase::Settling);
        assert_eq!(state.metrics.window_count("settled"), 0.0);
        assert_eq!(state.metrics.window_count("evicted"), 0.0);
    }

    #[test]
    fn sv5_three_consecutive_relay_drops_evict_and_one_does_not() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        let tx_hash = state.attempt.tx_hash().unwrap();

        front.set_status(tx_hash, crate::chain::FrontStatus::Dropped);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        assert!(state.attempt.is_in_flight(), "one drop is a skipped slot");

        front.set_status(tx_hash, crate::chain::FrontStatus::Held);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        assert!(state.attempt.is_in_flight());

        front.set_status(tx_hash, crate::chain::FrontStatus::Dropped);
        for _ in 0..3 {
            reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        }
        assert!(
            state.attempt.owes_resubmission(),
            "three in a row evict, and the window is owed one resubmission"
        );
    }

    #[test]
    fn sv4_a_rolled_back_window_records_its_cause_and_re_forms() {
        let (mut state, l2, l1, front) = settled_window(two_orders());
        record_settlement(&mut state, &l2, &front, &l1, 1_001);
        // It landed, and then the L2 block un-happened.
        let tx_hash = state.attempt.tx_hash().unwrap();
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        assert_eq!(state.window.phase, WindowPhase::Settled);

        let (mut state, l2, l1, front) = settled_window(two_orders());
        record_settlement(&mut state, &l2, &front, &l1, 1_001);
        l2.set_canonical(state.attempt.tx_hash().unwrap(), false);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();

        assert_eq!(state.window.phase, WindowPhase::RolledBack);
        assert_eq!(state.rollback_cause, Some(RollbackCause::BundleMissed));
        assert_eq!(state.metrics.window_count("rolled_back"), 1.0);
        assert!(state.selection.is_none());
        assert_ne!(tx_hash, B256::ZERO);
    }

    #[test]
    fn sv4_accounting_reads_the_finalized_head() {
        // The reconciler must ask for `finalized` on every tick: operations may
        // read `safe`, but an outcome is only final where L1 says it is.
        let (mut state, l2, l1, front) = settled_window(two_orders());
        l2.set_safe_block(64);
        l2.set_head_timestamp(1_800_000_768);
        record_settlement(&mut state, &l2, &front, &l1, 1_001);
        reconciler(&l2, &l1, &front).tick(&mut state).unwrap();
        assert_eq!(
            l2.finalized_head().unwrap(),
            HeadInfo {
                number: 32,
                timestamp: 1_800_000_384
            }
        );
        assert_eq!(state.window.phase, WindowPhase::Settled);
    }

    #[test]
    fn fl5_impact_bps_is_the_gap_between_p0_and_the_realised_price() {
        let mut result = WindowResult {
            amount_in: U256::ZERO,
            amount_out: U256::ZERO,
            reference_price_x96: U256::from(10_000u32),
            execution_price_x96: U256::from(9_900u32),
            post: fixture_mirror(),
            l1_block: 1,
        };
        assert_eq!(impact_bps(&result), 100.0, "one per cent is 100 bps");

        result.execution_price_x96 = result.reference_price_x96;
        assert_eq!(impact_bps(&result), 0.0, "no move, no impact");

        result.reference_price_x96 = U256::ZERO;
        assert_eq!(impact_bps(&result), 0.0, "an unpriced leg reports nothing");
    }
}
