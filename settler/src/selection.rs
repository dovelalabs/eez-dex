//! Limit selection — FL-8 and SV-2, as one pure function.
//!
//! At the slot boundary the settler reads the open orders, computes the cross
//! and the residual, simulates `SettlementRouter.settle` against the L1 head,
//! and then **drops limit-violating orders and re-simulates until stable**.
//! The result is a *suggestion*: `WindowBook` rebuilds the leg from the
//! selected ids that are still open and the L1 leg enforces the price band
//! (CT-9, CT-1).
//!
//! Three properties are load-bearing, and each is a test in this module:
//!
//! * **Inclusion-maximal** — no dropped order could be re-added without
//!   violating a limit.
//! * **Bounded** — the drop phase removes exactly one order per round and the
//!   re-add phase adds at least one per pass, so both are bounded by the number
//!   of orders and the whole loop runs at most `n**2 + 2n` simulations.
//! * **Deterministic** — the candidate list is sorted by id, the order dropped
//!   is always the lowest-id one that could be, and re-additions are tried in
//!   ascending id order. Nothing reads a map's iteration order or a clock, so
//!   two settlers with the same inputs produce the same selection (SV-2).
//!
//! **No LLM in the control path.** This is arithmetic.

use alloy_primitives::U256;

use crate::mirror::{self, MirrorError};
use crate::types::{Order, OrderId, PoolState, Side, WindowLeg, WindowResult};
use crate::window::{
    BandBound, BookParams, BuiltLeg, Fill, PricedSelection, WindowError, binding_orders, build_leg,
    charge_fees,
};

/// The L1 leg, simulated.
///
/// SV-2 simulates `SettlementRouter.settle` against the L1 head with
/// `eth_call`. The trait is what makes the selection loop a pure function of
/// its inputs: the live implementation calls the chain, and TS-3's unit and
/// property tests drive the same loop over [`MirrorSimulator`], the L1 pool's
/// state run through the shared `Mirror` maths.
pub trait LegSimulator {
    /// Executes `leg` against the L1 head and returns what the router would.
    ///
    /// An `Err` is the router reverting: the leg is not settleable as built,
    /// and the caller drops an order rather than submitting it.
    fn simulate(&self, leg: &WindowLeg) -> Result<WindowResult, SimulationError>;
}

/// Why a simulated leg would not settle. These are `SettlementRouter`'s own
/// reverts (CT-1), which is what lets the selection loop react to each one by
/// dropping the order that caused it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SimulationError {
    /// `P0`, the pre-trade spot read in-leg, is below the band's floor.
    #[error("the reference price {price} is below the band's floor {min}")]
    ReferenceBelowBand {
        /// The reference price the leg read.
        price: U256,
        /// The band's floor.
        min: U256,
    },
    /// `P0` is above the band's ceiling.
    #[error("the reference price {price} is above the band's ceiling {max}")]
    ReferenceAboveBand {
        /// The reference price the leg read.
        price: U256,
        /// The band's ceiling.
        max: U256,
    },
    /// The swap's realised average price is below the band's floor.
    #[error("the execution price {price} is below the band's floor {min}")]
    ExecutionBelowBand {
        /// The realised average price.
        price: U256,
        /// The band's floor.
        min: U256,
    },
    /// The swap's realised average price is above the band's ceiling.
    #[error("the execution price {price} is above the band's ceiling {max}")]
    ExecutionAboveBand {
        /// The realised average price.
        price: U256,
        /// The band's ceiling.
        max: U256,
    },
    /// `block.timestamp > leg.deadline` on L1 (CT-1).
    #[error("the leg's deadline has passed")]
    Expired,
    /// The pool could not be priced.
    #[error("{0}")]
    Mirror(#[from] MirrorError),
    /// The simulation could not be run at all — an RPC that did not answer, or
    /// a revert the settler cannot attribute to a band.
    #[error("the simulation did not answer: {0}")]
    Unavailable(String),
}

/// Why a candidate set is not settleable as it stands.
///
/// The distinction between the two band cases is the difference between a drop
/// that makes progress and one that does not: an *empty* band is relieved by
/// dropping either end, but a price *past* one end is relieved only by moving
/// that end.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
enum Infeasible {
    /// One or more selected orders would fill below their limit (CT-10).
    #[error("{0:?} would fill below their limit")]
    Limits(Vec<OrderId>),
    /// The tightest sell-side limit is above the tightest buy-side one, so the
    /// contract reverts before any L1 call (CT-9).
    #[error("the price band is empty")]
    EmptyBand,
    /// The simulated leg's price is past this end of the band (CT-1).
    #[error("the leg's price is outside the band at {0:?}")]
    OutsideBand(BandBound),
    /// The contract would revert before any L1 call for a reason no single
    /// order explains.
    #[error("{0}")]
    Structural(WindowError),
    /// The simulation could not be run.
    #[error("{0}")]
    Unavailable(String),
}

/// One evaluated candidate set: what the contract would build, what the leg
/// would return, and what every order would get.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    /// The priced selection, ascending by id.
    pub selection: PricedSelection,
    /// The leg the contract would build from it (CT-9).
    pub built: BuiltLeg,
    /// What the simulated L1 leg returned (CT-2).
    pub result: WindowResult,
    /// Every order's fill, as `_applyResult` would produce it.
    pub fills: Vec<Fill>,
}

impl Evaluation {
    /// The ids, ascending — what `settleWindow` is called with.
    pub fn ids(&self) -> Vec<OrderId> {
        self.selection.ids()
    }

    /// Orders whose fill would violate their limit and revert the settlement
    /// (CT-10), ascending by id.
    pub fn limit_violations(&self) -> Vec<OrderId> {
        self.fills
            .iter()
            .filter(|fill| !fill.honours_limit())
            .map(|fill| fill.id)
            .collect()
    }
}

/// Everything the selection loop needs that is not an order.
#[derive(Debug, Clone, Copy)]
pub struct SelectionInputs<'a> {
    /// The deployed book's parameters (CT-12).
    pub params: &'a BookParams,
    /// The mirror the book will net at — the book's stored snapshot, not the
    /// L1 head. The contract crosses at this price, so the settler must too.
    pub mirror: &'a PoolState,
    /// The window being closed.
    pub window_id: u64,
    /// `sync-block timestamp + DEADLINE_SECONDS` (SV-3).
    pub deadline: u64,
}

/// The outcome of one window's selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// The inclusion-maximal fillable subset, ascending by id. Empty when no
    /// subset settles — the window is not submitted and every order rolls.
    pub selected: Vec<OrderId>,
    /// Candidates left out, ascending by id. None of them could be re-added
    /// without violating a limit.
    pub dropped: Vec<OrderId>,
    /// The evaluation of `selected`. `None` when nothing is selectable.
    pub evaluation: Option<Evaluation>,
    /// How many simulations the loop ran — at most `n**2 + 2n` for `n`
    /// candidates, and reported so a stall is visible rather than inferred.
    pub simulations: u32,
    /// Set when no subset could be evaluated at all: the simulator did not
    /// answer, or the contract would revert for a reason no single order
    /// explains. It keeps "nobody is fillable" and "the settler could not
    /// tell" apart, which must never be reported as the same window.
    pub blocked: Option<String>,
}

/// The inclusion-maximal fillable subset of `candidates` (FL-8, SV-2).
///
/// `candidates` need not be sorted or deduplicated; the first thing this does
/// is put them in the canonical order, which is what makes the result
/// independent of the order they arrived in.
pub fn select_fillable(
    candidates: &[Order],
    inputs: SelectionInputs<'_>,
    simulator: &dyn LegSimulator,
) -> Selection {
    let candidates = crate::window::select(candidates, inputs.window_id);
    let mut simulations = 0;

    // --- drop phase: one order per round, so at most `n` rounds -------------
    let mut kept: Vec<Order> = candidates.clone();
    let mut evaluation = None;
    let mut blocked = None;
    while !kept.is_empty() {
        match evaluate(&kept, inputs, simulator, &mut simulations) {
            Ok(evaluated) => {
                evaluation = Some(evaluated);
                break;
            }
            Err(reason) => match drop_target(&kept, inputs, &reason) {
                Some(id) => kept.retain(|order| order.id != id),
                // Nothing identifiable to drop: no subset of this set settles.
                None => {
                    blocked = Some(reason.to_string());
                    kept.clear();
                    break;
                }
            },
        }
    }

    // --- re-add phase: inclusion-maximality (FL-8) --------------------------
    //
    // A drop can relax the band enough that an order dropped earlier fits
    // again, so the fixed point is only reached when a whole ascending pass
    // adds nothing. Each pass that continues has added at least one order, so
    // the phase is bounded by the candidate count.
    //
    // It runs even when the drop phase emptied the set. The drop phase removes
    // one order at a time, so it never sees most of the subsets it passes over
    // — a book where two orders conflict can end up empty while either alone
    // would settle. Starting the re-add from wherever the drop phase left off,
    // including nowhere, is what makes the result inclusion-maximal rather than
    // merely feasible. A blocked simulator is the one case worth skipping:
    // every trial would fail for the same reason.
    if blocked.is_none() {
        loop {
            let mut added = false;
            for candidate in &candidates {
                if kept.iter().any(|order| order.id == candidate.id) {
                    continue;
                }
                let mut trial = kept.clone();
                trial.push(candidate.clone());
                trial.sort_by_key(|order| order.id);
                if let Ok(evaluated) = evaluate(&trial, inputs, simulator, &mut simulations) {
                    kept = trial;
                    evaluation = Some(evaluated);
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
    }

    let selected: Vec<OrderId> = kept.iter().map(|order| order.id).collect();
    let dropped: Vec<OrderId> = candidates
        .iter()
        .map(|order| order.id)
        .filter(|id| !selected.contains(id))
        .collect();

    Selection {
        selected,
        dropped,
        evaluation: if kept.is_empty() { None } else { evaluation },
        simulations,
        blocked,
    }
}

/// Builds the leg the contract would build, simulates it, and checks every
/// order's fill against its limit.
fn evaluate(
    orders: &[Order],
    inputs: SelectionInputs<'_>,
    simulator: &dyn LegSimulator,
    simulations: &mut u32,
) -> Result<Evaluation, Infeasible> {
    let selection =
        charge_fees(orders, inputs.params, inputs.mirror).map_err(Infeasible::Structural)?;
    let built = build_leg(
        &selection,
        inputs.params,
        inputs.mirror,
        inputs.window_id,
        inputs.deadline,
    )
    .map_err(|error| match error {
        WindowError::EmptyPriceBand { .. } => Infeasible::EmptyBand,
        other => Infeasible::Structural(other),
    })?;

    *simulations += 1;
    let result = simulator
        .simulate(&built.leg)
        .map_err(|error| match error {
            SimulationError::ReferenceBelowBand { .. }
            | SimulationError::ExecutionBelowBand { .. } => {
                // The price is under the floor, so the floor is what has to move:
                // only a sell-side order that set it can relieve this.
                Infeasible::OutsideBand(BandBound::Min)
            }
            SimulationError::ReferenceAboveBand { .. }
            | SimulationError::ExecutionAboveBand { .. } => Infeasible::OutsideBand(BandBound::Max),
            SimulationError::Unavailable(reason) => Infeasible::Unavailable(reason),
            SimulationError::Expired => {
                Infeasible::Unavailable("the leg's deadline has passed".into())
            }
            SimulationError::Mirror(error) => Infeasible::Structural(error.into()),
        })?;

    let fills =
        crate::window::distribute(&selection, &built, &result).map_err(Infeasible::Structural)?;

    let evaluation = Evaluation {
        selection,
        built,
        result,
        fills,
    };
    let violations = evaluation.limit_violations();
    if violations.is_empty() {
        Ok(evaluation)
    } else {
        Err(Infeasible::Limits(violations))
    }
}

/// Which order to drop, given why the set is infeasible. Always the lowest id
/// among the orders that could relieve the failure (SV-2).
fn drop_target(
    orders: &[Order],
    inputs: SelectionInputs<'_>,
    reason: &Infeasible,
) -> Option<OrderId> {
    match reason {
        // Deterministic by construction: `limit_violations` is ascending.
        Infeasible::Limits(ids) => ids.first().copied(),
        // An empty band is relieved by dropping either end. Both are equally
        // valid, so the deterministic choice is the lower id of the two.
        Infeasible::EmptyBand => {
            let selection = charge_fees(orders, inputs.params, inputs.mirror).ok()?;
            let mut candidates = binding_orders(&selection, BandBound::Min);
            candidates.extend(binding_orders(&selection, BandBound::Max));
            candidates.sort_unstable();
            candidates.first().copied()
        }
        // A price past one end is relieved only by moving that end, so only
        // the orders that set it are candidates. Dropping the tightest lowers
        // the bound to the next tightest, which is what makes the loop
        // progress rather than circle.
        Infeasible::OutsideBand(bound) => {
            let selection = charge_fees(orders, inputs.params, inputs.mirror).ok()?;
            binding_orders(&selection, *bound).first().copied()
        }
        // A structural revert or an unavailable simulator is not one order's
        // fault, and dropping an arbitrary order to chase it would be guessing.
        Infeasible::Structural(_) | Infeasible::Unavailable(_) => None,
    }
}

/// The L1 leg simulated against a snapshot of the pool, through the same
/// `Mirror` maths the contracts use.
///
/// This is what TS-3 drives the selection loop with, and it is not a stand-in
/// for the chain: `SettlementRouter._settleLeg` reads `P0` from the adapter,
/// swaps, and checks both prices against the band, which is exactly the
/// sequence below. The live simulator ([`crate::chain`]) runs the same leg
/// through `eth_call` against the real head (SV-2).
#[derive(Debug, Clone, Copy)]
pub struct MirrorSimulator {
    /// The pool as it stands at the L1 head — not the book's mirror.
    pub head: PoolState,
    /// The L1 block the head was read at.
    pub l1_block: u64,
    /// The L1 timestamp the leg would execute at, for CT-1's deadline check.
    pub l1_timestamp: u64,
}

impl LegSimulator for MirrorSimulator {
    fn simulate(&self, leg: &WindowLeg) -> Result<WindowResult, SimulationError> {
        if self.l1_timestamp > leg.deadline {
            return Err(SimulationError::Expired);
        }

        let reference_price_x96 = mirror::spot_price_x96(&self.head)?;
        check_band(reference_price_x96, leg, Stage::Reference)?;

        // CT-6: a leg with no residual reads and returns state only.
        if leg.residual_in.is_zero() {
            return Ok(WindowResult {
                amount_in: U256::ZERO,
                amount_out: U256::ZERO,
                reference_price_x96,
                execution_price_x96: reference_price_x96,
                post: self.head,
                l1_block: self.l1_block,
            });
        }

        let (post, amount_out) = mirror::advance(&self.head, leg.residual_in, leg.residual_side)?;
        let execution_price_x96 = execution_price(leg.residual_side, leg.residual_in, amount_out)?;
        check_band(execution_price_x96, leg, Stage::Execution)?;

        Ok(WindowResult {
            amount_in: leg.residual_in,
            amount_out,
            reference_price_x96,
            execution_price_x96,
            post,
            l1_block: self.l1_block,
        })
    }
}

#[derive(Clone, Copy)]
enum Stage {
    Reference,
    Execution,
}

fn check_band(price: U256, leg: &WindowLeg, stage: Stage) -> Result<(), SimulationError> {
    if price < leg.min_price_x96 {
        return Err(match stage {
            Stage::Reference => SimulationError::ReferenceBelowBand {
                price,
                min: leg.min_price_x96,
            },
            Stage::Execution => SimulationError::ExecutionBelowBand {
                price,
                min: leg.min_price_x96,
            },
        });
    }
    if price > leg.max_price_x96 {
        return Err(match stage {
            Stage::Reference => SimulationError::ReferenceAboveBand {
                price,
                max: leg.max_price_x96,
            },
            Stage::Execution => SimulationError::ExecutionAboveBand {
                price,
                max: leg.max_price_x96,
            },
        });
    }
    Ok(())
}

/// The leg's realised average price, B per A in Q96 — as
/// `SettlementRouter._settleLeg` computes it.
pub fn execution_price(
    residual_side: Side,
    residual_in: U256,
    amount_out: U256,
) -> Result<U256, MirrorError> {
    use crate::math::{Q96, mul_div};
    Ok(if residual_side.sells_a() {
        mul_div(amount_out, Q96, residual_in)?
    } else {
        mul_div(residual_in, Q96, amount_out)?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Q96;
    use crate::testkit::{Rng, fixture_mirror, fixture_params, order, pool_at};
    use crate::window::BookParams;

    const DEADLINE: u64 = 1_800_000_024;

    fn inputs<'a>(params: &'a BookParams, mirror_state: &'a PoolState) -> SelectionInputs<'a> {
        SelectionInputs {
            params,
            mirror: mirror_state,
            window_id: 0,
            deadline: DEADLINE,
        }
    }

    fn head(price_b_per_a: u64) -> MirrorSimulator {
        MirrorSimulator {
            head: pool_at(price_b_per_a),
            l1_block: 1_000,
            l1_timestamp: DEADLINE - 12,
        }
    }

    /// A book of eight orders across both sides with limits spread around the
    /// mirror's 2000 B per A — the scenario A.6's happy path places.
    fn eight_orders() -> Vec<Order> {
        vec![
            // A-side sellers, tightest limit last.
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
            // B-side sellers, tightest limit last.
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

    /// Every selected order fills at or above its limit — the property CT-10
    /// enforces on-chain and the settler must never make the contract test.
    fn assert_no_limit_violation(selection: &Selection) {
        let Some(evaluation) = &selection.evaluation else {
            return;
        };
        for fill in &evaluation.fills {
            assert!(
                fill.honours_limit(),
                "order {:?} would fill at {} against a limit of {}",
                fill.id,
                fill.amount_out,
                fill.min_buy_amount
            );
        }
    }

    #[test]
    fn sv2_selection_converges_and_never_selects_a_limit_violating_order() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let orders = eight_orders();

        // A quiet head, and two that have drifted away from the mirror.
        for price in [2000u64, 1900, 2100] {
            let selection = select_fillable(&orders, inputs(&params, &mirror_state), &head(price));
            assert!(
                selection.blocked.is_none(),
                "the head at {price} is simulable"
            );
            assert_no_limit_violation(&selection);
            assert_eq!(
                selection.selected.len() + selection.dropped.len(),
                orders.len(),
                "every candidate is either selected or dropped"
            );
            let mut ascending = selection.selected.clone();
            ascending.sort_unstable();
            assert_eq!(selection.selected, ascending, "ids are ascending (SV-2)");
        }
    }

    #[test]
    fn fl8_drift_rolls_the_orders_outside_their_limit_and_fills_the_rest() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let orders = eight_orders();

        let calm = select_fillable(&orders, inputs(&params, &mirror_state), &head(2000));
        let drifted = select_fillable(&orders, inputs(&params, &mirror_state), &head(1700));

        assert!(
            drifted.selected.len() < calm.selected.len(),
            "a 15% move must cost some orders their limit"
        );
        assert!(!drifted.dropped.is_empty());
        assert_no_limit_violation(&drifted);
        // Nobody is filled worse than their limit; the rest simply roll (FL-8).
        for dropped in &drifted.dropped {
            assert!(!drifted.selected.contains(dropped));
        }
    }

    #[test]
    fn fl8_selection_is_inclusion_maximal() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let orders = eight_orders();
        let simulator = head(1850);
        let selection = select_fillable(&orders, inputs(&params, &mirror_state), &simulator);

        // No dropped order could be re-added without violating a limit.
        for dropped in &selection.dropped {
            let mut trial: Vec<Order> = orders
                .iter()
                .filter(|o| selection.selected.contains(&o.id) || o.id == *dropped)
                .cloned()
                .collect();
            trial.sort_by_key(|order| order.id);
            let mut simulations = 0;
            assert!(
                evaluate(
                    &trial,
                    inputs(&params, &mirror_state),
                    &simulator,
                    &mut simulations
                )
                .is_err(),
                "re-adding {dropped:?} must violate a limit — otherwise the \
                 selection was not inclusion-maximal"
            );
        }
    }

    #[test]
    fn selection_is_deterministic_across_permutations() {
        // SV-2 / TS-3: identical selection for every permutation of the same
        // input set, so any two settlers agree.
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let mut rng = Rng::new(0xdec1_5104);

        for case in 0..24u32 {
            let orders = random_orders(&mut rng, 6);
            let price = rng.in_range(1_700, 2_300);
            let simulator = head(price);
            let expected = select_fillable(&orders, inputs(&params, &mirror_state), &simulator);
            assert_no_limit_violation(&expected);

            for permutation in 0..8u32 {
                let mut shuffled = orders.clone();
                rng.shuffle(&mut shuffled);
                let actual = select_fillable(&shuffled, inputs(&params, &mirror_state), &simulator);
                assert_eq!(
                    actual.selected, expected.selected,
                    "case {case} permutation {permutation} at {price} B per A \
                     produced a different selection"
                );
                assert_eq!(actual.dropped, expected.dropped);
                assert_eq!(
                    actual.evaluation.as_ref().map(|e| e.built.leg.clone()),
                    expected.evaluation.as_ref().map(|e| e.built.leg.clone()),
                    "the same selection must build the same leg"
                );
            }
        }
    }

    #[test]
    fn sv2_selection_is_inclusion_maximal_under_random_books() {
        // The property, over seeded random books: inclusion-maximal, no limit
        // violated, and bounded by the candidate count squared.
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let mut rng = Rng::new(0xf1_11ab1e);

        for _ in 0..40u32 {
            let count = rng.in_range(1, 7) as usize;
            let orders = random_orders(&mut rng, count);
            let simulator = head(rng.in_range(1_600, 2_400));
            let selection = select_fillable(&orders, inputs(&params, &mirror_state), &simulator);

            assert_no_limit_violation(&selection);
            let n = orders.len() as u32;
            assert!(
                selection.simulations <= n * n + 2 * n,
                "{} simulations for {n} orders is not bounded by the order count",
                selection.simulations
            );

            for dropped in &selection.dropped {
                let mut trial: Vec<Order> = orders
                    .iter()
                    .filter(|o| selection.selected.contains(&o.id) || o.id == *dropped)
                    .cloned()
                    .collect();
                trial.sort_by_key(|order| order.id);
                let mut simulations = 0;
                assert!(
                    evaluate(
                        &trial,
                        inputs(&params, &mirror_state),
                        &simulator,
                        &mut simulations
                    )
                    .is_err(),
                    "{dropped:?} could have been re-added"
                );
            }
        }
    }

    /// `count` orders with sizes and limits drawn from the seeded generator,
    /// spread either side of the mirror's 2000 B per A.
    fn random_orders(rng: &mut Rng, count: usize) -> Vec<Order> {
        let mut orders = Vec::with_capacity(count);
        for i in 0..count {
            let sells_a = rng.next_u64().is_multiple_of(2);
            // Limits from 5% through the mirror price to 12% away from it.
            let tolerance_bps = rng.in_range(9_500, 11_200);
            if sells_a {
                let sell = u128::from(rng.in_range(1, 8)) * 1_000_000_000_000_000_000;
                // Wants at least `sell * 2000 * tolerance/10000` of B.
                let min_buy = sell * 2_000 * u128::from(tolerance_bps) / 10_000;
                orders.push(order(
                    (i + 1) as u8,
                    Side::SellAForB,
                    &sell.to_string(),
                    &min_buy.to_string(),
                ));
            } else {
                let sell = u128::from(rng.in_range(1, 8)) * 1_000_000_000_000_000_000_000;
                // Wants at least `sell / 2000 * 10000/tolerance` of A.
                let min_buy = sell / 2_000 * 10_000 / u128::from(tolerance_bps);
                orders.push(order(
                    (i + 1) as u8,
                    Side::SellBForA,
                    &sell.to_string(),
                    &min_buy.to_string(),
                ));
            }
        }
        orders
    }

    #[test]
    fn fl8_a_move_past_every_limit_selects_nobody_and_says_so() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        // Every order wants at least ~1900 B per A; the head is at 900.
        let orders: Vec<Order> = (1..=4)
            .map(|i| {
                order(
                    i,
                    Side::SellAForB,
                    "1000000000000000000",
                    "1900000000000000000000",
                )
            })
            .collect();

        let selection = select_fillable(&orders, inputs(&params, &mirror_state), &head(900));
        assert!(selection.selected.is_empty(), "nobody is fillable");
        assert_eq!(selection.dropped.len(), 4);
        assert!(selection.evaluation.is_none());
        // Not blocked: the settler could tell, and the answer was "nobody".
        assert!(selection.blocked.is_none());
    }

    #[test]
    fn sv2_a_simulator_that_cannot_answer_blocks_rather_than_rolling_everyone() {
        struct Dead;
        impl LegSimulator for Dead {
            fn simulate(&self, _leg: &WindowLeg) -> Result<WindowResult, SimulationError> {
                Err(SimulationError::Unavailable("l1 rpc timed out".into()))
            }
        }
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let selection = select_fillable(&eight_orders(), inputs(&params, &mirror_state), &Dead);

        assert!(selection.selected.is_empty());
        assert_eq!(
            selection.blocked.as_deref(),
            Some("l1 rpc timed out"),
            "an unanswered simulation is not the same as an unfillable window"
        );
    }

    #[test]
    fn ct9_an_empty_band_drops_the_lower_id_of_the_two_orders_that_set_it() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        // Order 3 demands at least 3000 B per A; order 7 will not pay above
        // ~1500. No price satisfies both, and neither is at fault, so the
        // deterministic drop is the lower id.
        let orders = vec![
            order(
                3,
                Side::SellAForB,
                "1000000000000000000",
                "3000000000000000000000",
            ),
            order(
                7,
                Side::SellBForA,
                "3000000000000000000000",
                "1400000000000000000",
            ),
        ];
        let selection = select_fillable(&orders, inputs(&params, &mirror_state), &head(2000));
        assert_eq!(selection.dropped, vec![orders[0].id], "the lower id goes");
        assert_eq!(selection.selected, vec![orders[1].id]);
        assert_no_limit_violation(&selection);
    }

    #[test]
    fn ct6_a_leg_with_no_residual_reads_state_and_swaps_nothing() {
        let simulator = head(2000);
        let leg = WindowLeg {
            window_id: 7,
            residual_side: Side::SellAForB,
            residual_in: U256::ZERO,
            min_price_x96: U256::ZERO,
            max_price_x96: U256::MAX,
            deadline: DEADLINE,
            distribution: Vec::new(),
        };
        let result = simulator.simulate(&leg).unwrap();
        assert_eq!(result.amount_in, U256::ZERO);
        assert_eq!(result.amount_out, U256::ZERO);
        assert_eq!(result.reference_price_x96, result.execution_price_x96);
        assert_eq!(result.post, simulator.head, "state only");
        assert_eq!(result.reference_price_x96 / Q96, U256::from(2000u16));
    }

    #[test]
    fn ct1_the_simulator_expires_on_a_timestamp_the_way_l1_does() {
        let mut simulator = head(2000);
        simulator.l1_timestamp = DEADLINE + 1;
        let leg = WindowLeg {
            window_id: 0,
            residual_side: Side::SellAForB,
            residual_in: U256::from(1u8),
            min_price_x96: U256::ZERO,
            max_price_x96: U256::MAX,
            deadline: DEADLINE,
            distribution: Vec::new(),
        };
        assert_eq!(simulator.simulate(&leg), Err(SimulationError::Expired));
    }

    #[test]
    fn ct1_the_simulator_checks_both_ends_of_the_band_for_both_prices() {
        let simulator = head(2000);
        let base = WindowLeg {
            window_id: 0,
            residual_side: Side::SellAForB,
            residual_in: U256::from(10u8).pow(U256::from(18u8)),
            min_price_x96: U256::ZERO,
            max_price_x96: U256::MAX,
            deadline: DEADLINE,
            distribution: Vec::new(),
        };

        // `P0` below the floor, and above the ceiling.
        let floor_too_high = WindowLeg {
            min_price_x96: U256::from(2_100u16) << 96usize,
            ..base.clone()
        };
        assert!(matches!(
            simulator.simulate(&floor_too_high),
            Err(SimulationError::ReferenceBelowBand { .. })
        ));
        let ceiling_too_low = WindowLeg {
            max_price_x96: U256::from(1_900u16) << 96usize,
            ..base.clone()
        };
        assert!(matches!(
            simulator.simulate(&ceiling_too_low),
            Err(SimulationError::ReferenceAboveBand { .. })
        ));

        // A band `P0` sits inside but the swap's realised average does not —
        // the impact of the residual itself.
        let tight = WindowLeg {
            min_price_x96: mirror::spot_price_x96(&simulator.head).unwrap(),
            residual_in: U256::from(50u8) * U256::from(10u8).pow(U256::from(18u8)),
            ..base
        };
        assert!(matches!(
            simulator.simulate(&tight),
            Err(SimulationError::ExecutionBelowBand { .. })
        ));
    }
}
