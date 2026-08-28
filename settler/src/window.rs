//! The window's arithmetic, as pure functions (SV-2).
//!
//! Every function here is the Rust twin of a private function in
//! `WindowBook.settleWindow`: [`charge_fees`] of `_chargeFees`, [`build_leg`]
//! of `_buildLeg`, [`price_band`] of `_priceBand`, [`distribute`] of
//! `_applyResult` and `_impact`. They exist so the settler can answer *what
//! will the contract do with this set of ids* before spending a slot finding
//! out (FL-8), and they are pure so that the answer is auditable and identical
//! on any settler (SV-2).
//!
//! **This is a prediction, not an instruction.** `settleWindow` takes order
//! ids; the contract rebuilds the leg from the ids that are still open and
//! enforces every limit itself (CT-9, CT-10). Nothing here is sent anywhere.
//!
//! The parameters the arithmetic needs — profile, fee shape, route-fee model —
//! are read from the deployed book rather than from configuration, because the
//! book is the authority on the fee it charges. A settler whose fee arithmetic
//! disagreed with the book's would select orders the contract then refuses.

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolValue;

use crate::abi;
use crate::math::{BPS_DENOMINATOR, MathError, Q96, mul_div, mul_div_ceil};
use crate::mirror::{self, MirrorError};
use crate::types::{Order, OrderId, PoolState, Side, WindowLeg, WindowResult};

/// Which build profile the deployed book runs (RD-2 §1). Configuration, never
/// a fork — and the settler reads it from the book rather than deciding it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookProfile {
    /// Bought assets land in L2 balances in-frame; the leg carries no
    /// distribution (CT-11).
    Full,
    /// Atomic L2->L1 calls only; the leg carries the L1 distribution (CT-4).
    Genesis,
}

/// EC-1's two fee shapes, as the book carries them. Both are taken in the sell
/// asset (CT-12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookFee {
    /// `FEE_BPS` — basis points of notional.
    Bps(u16),
    /// `FEE_FIXED` — a fixed amount per order, per sell asset.
    Fixed {
        /// In A's units.
        a: U256,
        /// In B's units.
        b: U256,
    },
}

/// `ROUTE_FEE_MODEL`. `Absorb` is the launch setting (EC-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookRouteFee {
    /// The protocol absorbs the window's route fee.
    Absorb,
    /// It is recovered from fills pro-rata by size, in wei.
    Recover(U256),
}

/// The deployed book's own parameters, read from its public immutables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BookParams {
    /// Which profile the deployment runs.
    pub profile: BookProfile,
    /// L2 address of A; `address(0)` is native zone ETH.
    pub asset_a: Address,
    /// L2 address of B; `address(0)` is native zone ETH.
    pub asset_b: Address,
    /// The protocol fee's shape.
    pub fee: BookFee,
    /// Who pays the route fee, and how much of it there is.
    pub route_fee: BookRouteFee,
}

impl BookParams {
    fn sell_asset(&self, side: Side) -> Address {
        if side.sells_a() {
            self.asset_a
        } else {
            self.asset_b
        }
    }
}

/// Why the contract would refuse to settle this selection. Each variant is a
/// revert `settleWindow` produces for the same input, which is what makes an
/// error here a reason to drop an order rather than a bug.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WindowError {
    /// No id in the list is still open and unexpired — `NothingToSettle`.
    #[error("no selected order is still open")]
    NothingSelected,
    /// The fees would consume the whole order — `FeeExceedsOrder(id)`.
    #[error("fees consume order {0}")]
    FeeExceedsOrder(OrderId),
    /// The selection crosses nothing and swaps nothing — `NothingToSettle`.
    #[error("the selection crosses nothing and swaps nothing")]
    NothingToSettle,
    /// The tightest sell-side limit is above the tightest buy-side one —
    /// `EmptyPriceBand`.
    #[error("empty price band: min {min} > max {max}")]
    EmptyPriceBand {
        /// The tightest sell-side bound.
        min: U256,
        /// The tightest buy-side bound.
        max: U256,
    },
    /// The leg returned a zero reference price — `MalformedResult`.
    #[error("the leg returned no reference price")]
    MalformedResult,
    /// Pricing the mirror failed the way the on-chain library reverts.
    #[error("{0}")]
    Mirror(#[from] MirrorError),
    /// Fixed-point arithmetic that reverts on-chain for the same input.
    #[error("{0}")]
    Math(#[from] MathError),
}

/// One selected order, priced — the Rust twin of the contract's `Selection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedOrder {
    /// The order as the book holds it.
    pub order: Order,
    /// EC-1's protocol fee, in sell-asset units.
    pub fee: U256,
    /// This order's share of the window's route fee, in sell-asset units.
    pub route_fee: U256,
    /// `sellAmount - fee - routeFee`: what actually enters the window.
    pub net_in: U256,
}

/// A whole selection, priced and summed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedSelection {
    /// The orders, in ascending id order.
    pub orders: Vec<PricedOrder>,
    /// Σ `net_in` on the A side.
    pub sum_a: U256,
    /// Σ `net_in` on the B side.
    pub sum_b: U256,
}

impl PricedSelection {
    /// The ids, ascending — what `settleWindow` is called with.
    pub fn ids(&self) -> Vec<OrderId> {
        self.orders.iter().map(|priced| priced.order.id).collect()
    }

    /// Gross volume before crossing, valued in A at `price_x96` — the
    /// denominator of `netting_ratio` (A.5) and of EC-1's size gate.
    pub fn gross_in_a(&self, price_x96: U256) -> Result<U256, WindowError> {
        let b_in_a = if self.sum_b.is_zero() {
            U256::ZERO
        } else {
            mul_div(self.sum_b, Q96, price_x96)?
        };
        Ok(self.sum_a + b_in_a)
    }
}

/// The leg the contract will build, plus what the split implies for the fills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltLeg {
    /// The leg itself (A.1).
    pub leg: WindowLeg,
    /// True when the residual side is `SELL_A_FOR_B`.
    pub residual_is_a: bool,
    /// What the crossed side collectively receives, in its buy asset. Fixed
    /// when the leg is built, because the residual sent to L1 is.
    pub cross_pot: U256,
}

/// One order's fill, as `_applyResult` and `_fill` would produce it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fill {
    /// The order filled.
    pub id: OrderId,
    /// Net output after every deduction. CT-10 requires `>= min_buy_amount`.
    pub amount_out: U256,
    /// The order's limit, carried so a violation is legible without a lookup.
    pub min_buy_amount: U256,
    /// EC-1's protocol fee, in sell-asset units (CT-12).
    pub fee_amount: U256,
    /// The route-fee share, in sell-asset units (CT-12).
    pub route_fee_amount: U256,
    /// The pro-rata impact share, in sell-asset units. Zero if crossed (FL-5).
    pub impact_amount: U256,
    /// True when the order was matched inside the window rather than on L1.
    pub crossed: bool,
    /// The price this order cleared at, B per A in Q96 (IX-2 `OrderFill`).
    pub price_x96: U256,
}

impl Fill {
    /// Whether the fill honours the order's limit (CT-10). The contract makes
    /// the same comparison and reverts the whole settlement if it fails.
    pub fn honours_limit(&self) -> bool {
        self.amount_out >= self.min_buy_amount
    }
}

/// Drops ids that are not open or have expired, and duplicates with them —
/// `WindowBook._select`.
///
/// The settler's list is a suggestion, never an instruction (FL-8): this is
/// what makes a cancel landing in the Sync block shrink the selection rather
/// than revert it (CT-7, CT-9). Orders are returned in **ascending id order**,
/// the settler's canonical order (SV-2).
pub fn select<'a>(candidates: impl IntoIterator<Item = &'a Order>, window_id: u64) -> Vec<Order> {
    let mut selected: Vec<Order> = candidates
        .into_iter()
        .filter(|order| !order.is_expired(window_id))
        .cloned()
        .collect();
    selected.sort_by_key(|order| order.id);
    selected.dedup_by(|a, b| a.id == b.id);
    selected
}

/// EC-1's fee, plus the route-fee split when `RECOVER` — `_chargeFees`.
///
/// Both are taken in the sell asset and both come off the *input*, so the
/// netting, the price band and every limit are computed net of them (CT-12).
pub fn charge_fees(
    orders: &[Order],
    params: &BookParams,
    mirror_state: &PoolState,
) -> Result<PricedSelection, WindowError> {
    if orders.is_empty() {
        return Err(WindowError::NothingSelected);
    }

    // Sizes on the two sides are in different units, so pro-rata needs one
    // scale: A-equivalents at the mirror price.
    let mut notional = vec![U256::ZERO; orders.len()];
    let mut notional_total = U256::ZERO;
    let route_total = match params.route_fee {
        BookRouteFee::Recover(wei) if !wei.is_zero() => {
            let price_x96 = mirror::spot_price_x96(mirror_state)?;
            for (i, order) in orders.iter().enumerate() {
                notional[i] = if order.side.sells_a() {
                    order.sell_amount
                } else {
                    mul_div(order.sell_amount, Q96, price_x96)?
                };
                notional_total += notional[i];
            }
            wei
        }
        _ => U256::ZERO,
    };

    let mut priced = Vec::with_capacity(orders.len());
    let mut sum_a = U256::ZERO;
    let mut sum_b = U256::ZERO;

    for (i, order) in orders.iter().enumerate() {
        let fee = protocol_fee(order.sell_amount, order.side, params)?;
        let route_fee = if notional_total.is_zero() {
            U256::ZERO
        } else {
            route_fee_in_sell_asset(
                mul_div(route_total, notional[i], notional_total)?,
                order.side,
                params,
                mirror_state,
            )?
        };
        if fee + route_fee >= order.sell_amount {
            return Err(WindowError::FeeExceedsOrder(order.id));
        }
        let net_in = order.sell_amount - fee - route_fee;
        if order.side.sells_a() {
            sum_a += net_in;
        } else {
            sum_b += net_in;
        }
        priced.push(PricedOrder {
            order: order.clone(),
            fee,
            route_fee,
            net_in,
        });
    }

    Ok(PricedSelection {
        orders: priced,
        sum_a,
        sum_b,
    })
}

/// FL-4's cross and residual, then CT-9's price band — `_buildLeg`.
///
/// The crossed volume is fixed **here**, before the L1 call, because
/// `residualIn` is: the two are the same number seen from opposite sides. The
/// only price available at that moment is the mirror's, so the mirror price is
/// what the window nets at, and the residual side carries the whole difference
/// between that and the `P0` the leg returns (FL-5).
pub fn build_leg(
    selection: &PricedSelection,
    params: &BookParams,
    mirror_state: &PoolState,
    window_id: u64,
    deadline: u64,
) -> Result<BuiltLeg, WindowError> {
    let price_x96 = mirror::spot_price_x96(mirror_state)?;

    let sum_b_in_a = if selection.sum_b.is_zero() {
        U256::ZERO
    } else {
        mul_div(selection.sum_b, Q96, price_x96)?
    };

    let (residual_is_a, cross_pot, residual_in) = if selection.sum_a >= sum_b_in_a {
        (true, sum_b_in_a, selection.sum_a - sum_b_in_a)
    } else {
        let cross_pot = mul_div(selection.sum_a, price_x96, Q96)?;
        (false, cross_pot, selection.sum_b - cross_pot)
    };

    // A selection whose whole volume is worth less than one unit of the other
    // asset crosses nothing and swaps nothing; the contract reverts here
    // rather than paying for an empty leg (FL-7, CT-13).
    if residual_in.is_zero() && cross_pot.is_zero() {
        return Err(WindowError::NothingToSettle);
    }

    let (min_price_x96, max_price_x96) = price_band(selection)?;
    if min_price_x96 > max_price_x96 {
        return Err(WindowError::EmptyPriceBand {
            min: min_price_x96,
            max: max_price_x96,
        });
    }

    let residual_side = if residual_is_a {
        Side::SellAForB
    } else {
        Side::SellBForA
    };

    Ok(BuiltLeg {
        leg: WindowLeg {
            window_id,
            residual_side,
            residual_in,
            min_price_x96,
            max_price_x96,
            deadline,
            distribution: distribution(selection, params, residual_is_a),
        },
        residual_is_a,
        cross_pot,
    })
}

/// The tightest sell-side limit and the tightest buy-side limit among the
/// selected orders — `_priceBand`.
///
/// Each is already widened by that side's fee, because the bounds are derived
/// from `net_in`: the pool price they demand is the one that leaves the user
/// their limit *after* fees. The residual side is widened by nothing — impact
/// is checked per order after execution (CT-9, CT-10).
///
/// An A-side order needs `net_in * P / 2**96 >= min_buy`, a lower bound on P;
/// a B-side order needs `net_in * 2**96 / P >= min_buy`, an upper one. An order
/// with no limit bounds nothing.
pub fn price_band(selection: &PricedSelection) -> Result<(U256, U256), WindowError> {
    let mut min_price_x96 = U256::ZERO;
    let mut max_price_x96 = U256::MAX;

    for priced in &selection.orders {
        let min_buy = priced.order.min_buy_amount;
        if min_buy.is_zero() {
            continue;
        }
        if priced.order.side.sells_a() {
            let bound = mul_div_ceil(min_buy, Q96, priced.net_in)?;
            if bound > min_price_x96 {
                min_price_x96 = bound;
            }
        } else {
            let bound = mul_div(priced.net_in, Q96, min_buy)?;
            if bound < max_price_x96 {
                max_price_x96 = bound;
            }
        }
    }

    Ok((min_price_x96, max_price_x96))
}

/// Which selected orders set each end of the band, ascending by id.
///
/// When a bound cannot be met, the order that set it is the one whose removal
/// relaxes the band; picking the lowest id among equals is what makes the drop
/// deterministic (SV-2).
pub fn binding_orders(selection: &PricedSelection, bound: BandBound) -> Vec<OrderId> {
    let Ok((min_price_x96, max_price_x96)) = price_band(selection) else {
        return Vec::new();
    };
    let mut ids: Vec<OrderId> = selection
        .orders
        .iter()
        .filter(|priced| {
            if priced.order.min_buy_amount.is_zero() {
                return false;
            }
            match bound {
                BandBound::Min => {
                    priced.order.side.sells_a()
                        && mul_div_ceil(priced.order.min_buy_amount, Q96, priced.net_in)
                            == Ok(min_price_x96)
                }
                BandBound::Max => {
                    !priced.order.side.sells_a()
                        && mul_div(priced.net_in, Q96, priced.order.min_buy_amount)
                            == Ok(max_price_x96)
                }
            }
        })
        .map(|priced| priced.order.id)
        .collect();
    ids.sort_unstable();
    ids
}

/// Which end of the price band an order binds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BandBound {
    /// `minPriceX96` — the tightest sell-side limit, set by an A-side order.
    Min,
    /// `maxPriceX96` — the tightest buy-side limit, set by a B-side order.
    Max,
}

/// **\[genesis\]** the leg carries `(recipient, netIn)[]` for the L1
/// distribution (CT-4); **\[full\]** delivery is the bridge's, so it is empty.
fn distribution(selection: &PricedSelection, params: &BookParams, residual_is_a: bool) -> Vec<u8> {
    if params.profile != BookProfile::Genesis {
        return Vec::new();
    }
    let credits: Vec<abi::Credit> = selection
        .orders
        .iter()
        .filter(|priced| priced.order.side.sells_a() == residual_is_a)
        .map(|priced| abi::Credit {
            recipient: priced.order.recipient,
            amount: priced.net_in,
        })
        .collect();
    credits.abi_encode()
}

/// Every order's fill, from the leg's result — `_applyResult`, `_fill` and
/// `_impact` together.
///
/// The residual side receives everything the crossed side sold plus the leg's
/// output; the crossed side receives the pot fixed when the leg was built.
/// Both pots are exhausted exactly, so no path leaves the protocol long or
/// short (EC-2) and the remainder is rounding dust (CT-12).
///
/// CT-10 is **not** enforced here: the contract enforces it, and the settler's
/// job is to see the violation coming and drop the order instead (FL-8). Use
/// [`Fill::honours_limit`] to find the ones that would revert the settlement.
pub fn distribute(
    selection: &PricedSelection,
    built: &BuiltLeg,
    result: &WindowResult,
) -> Result<Vec<Fill>, WindowError> {
    let p0 = result.reference_price_x96;
    if p0.is_zero() {
        return Err(WindowError::MalformedResult);
    }

    let (residual_sum, crossed_sum) = if built.residual_is_a {
        (selection.sum_a, selection.sum_b)
    } else {
        (selection.sum_b, selection.sum_a)
    };
    let residual_pot = crossed_sum + result.amount_out;

    let mut fills = Vec::with_capacity(selection.orders.len());
    for priced in &selection.orders {
        let is_residual = priced.order.side.sells_a() == built.residual_is_a;
        let amount_out = if is_residual {
            mul_div(residual_pot, priced.net_in, residual_sum)?
        } else {
            mul_div(built.cross_pot, priced.net_in, crossed_sum)?
        };
        let impact_amount = if is_residual {
            impact(priced, amount_out, p0)?
        } else {
            U256::ZERO
        };
        fills.push(Fill {
            id: priced.order.id,
            amount_out,
            min_buy_amount: priced.order.min_buy_amount,
            fee_amount: priced.fee,
            route_fee_amount: priced.route_fee,
            impact_amount,
            crossed: !is_residual,
            price_x96: realised_price_x96(priced, amount_out, p0)?,
        });
    }

    Ok(fills)
}

/// What the residual side paid for causing the swap, in **sell-asset units**
/// (CT-12) — `_impact`: the part of its input that bought nothing at `P0`.
///
/// Crossed orders never pay impact and never receive it as a windfall, so
/// theirs is zero (FL-5, EC-3). A fill better than `P0` reports zero rather
/// than a negative cost.
fn impact(priced: &PricedOrder, amount_out: U256, p0: U256) -> Result<U256, WindowError> {
    let input_at_p0 = if priced.order.side.sells_a() {
        mul_div(amount_out, Q96, p0)?
    } else {
        mul_div(amount_out, p0, Q96)?
    };
    Ok(priced.net_in.saturating_sub(input_at_p0))
}

/// The price this order actually cleared at, B per A in Q96 — its own output
/// over its own input (IX-2's `OrderFill.priceX96`).
///
/// For a residual-side order that is `P0` less its impact share, as IX-2
/// states it. For a crossed order it is the price the window netted at, which
/// *is* `P0` in the steady state; under drift the crossed side keeps the price
/// it was quoted and the residual side carries the difference (FL-5, CT-9), so
/// reporting the realised ratio is the honest figure in both cases.
fn realised_price_x96(
    priced: &PricedOrder,
    amount_out: U256,
    p0: U256,
) -> Result<U256, WindowError> {
    if amount_out.is_zero() || priced.net_in.is_zero() {
        return Ok(p0);
    }
    Ok(if priced.order.side.sells_a() {
        mul_div(amount_out, Q96, priced.net_in)?
    } else {
        mul_div(priced.net_in, Q96, amount_out)?
    })
}

fn protocol_fee(sell_amount: U256, side: Side, params: &BookParams) -> Result<U256, WindowError> {
    Ok(match params.fee {
        BookFee::Bps(bps) => mul_div(sell_amount, U256::from(bps), U256::from(BPS_DENOMINATOR))?,
        BookFee::Fixed { a, b } => {
            if side.sells_a() {
                a
            } else {
                b
            }
        }
    })
}

/// The route fee is quoted in wei; when the sell asset is not ETH it is
/// converted at the mirror price — `_routeFeeInSellAsset`.
fn route_fee_in_sell_asset(
    amount_wei: U256,
    side: Side,
    params: &BookParams,
    mirror_state: &PoolState,
) -> Result<U256, WindowError> {
    if params.sell_asset(side) == Address::ZERO {
        return Ok(amount_wei);
    }
    let price_x96 = mirror::spot_price_x96(mirror_state)?;
    Ok(if side.sells_a() {
        mul_div(amount_wei, Q96, price_x96)?
    } else {
        mul_div(amount_wei, price_x96, Q96)?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{fixture_mirror, fixture_orders, fixture_params, order, wei};
    use alloy_primitives::b256;

    #[test]
    fn ct12_the_fixtures_fees_and_net_inputs_match_the_book() {
        let priced = charge_fees(&fixture_orders(), &fixture_params(), &fixture_mirror()).unwrap();
        assert_eq!(priced.orders[0].fee, wei("1000000000000000"));
        assert_eq!(priced.orders[0].net_in, wei("9999000000000000000"));
        assert_eq!(priced.orders[1].fee, wei("1000000000000000000"));
        assert_eq!(priced.orders[1].net_in, wei("9999000000000000000000"));
        assert_eq!(priced.sum_a, priced.orders[0].net_in);
        assert_eq!(priced.sum_b, priced.orders[1].net_in);
        assert!(
            priced.orders.iter().all(|p| p.route_fee.is_zero()),
            "absorbed at launch"
        );
    }

    #[test]
    fn leg_parity_matches_onchain_fixture() {
        // TS-3: the builder's `WindowLeg` equals `WindowBook`'s on-chain
        // construction for `contracts/test/l2/fixtures/leg-parity.json`.
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let selection = charge_fees(&fixture_orders(), &params, &mirror_state).unwrap();
        let built = build_leg(&selection, &params, &mirror_state, 0, 1_800_000_024).unwrap();

        assert_eq!(built.leg.window_id, 0, "leg-parity: windowId");
        assert_eq!(
            built.leg.residual_side,
            Side::SellAForB,
            "leg-parity: residualSide"
        );
        assert_eq!(
            built.leg.residual_in,
            wei("4999500000000000000"),
            "leg-parity: residualIn"
        );
        assert_eq!(
            built.leg.min_price_x96,
            wei("150548563633465587986532158854286"),
            "leg-parity: minPriceX96"
        );
        assert_eq!(
            built.leg.max_price_x96,
            wei("161673958567373288081193052940747"),
            "leg-parity: maxPriceX96"
        );
        assert_eq!(built.leg.deadline, 1_800_000_024, "leg-parity: deadline");
        assert!(
            built.leg.distribution.is_empty(),
            "leg-parity: [full] carries no L1 distribution"
        );
        // The fixture's `crossedInA` is the pot the B side collectively takes.
        assert_eq!(built.cross_pot, wei("4999500000000000000"));
    }

    #[test]
    fn ct4_the_genesis_leg_carries_the_residual_sides_distribution() {
        let params = BookParams {
            profile: BookProfile::Genesis,
            asset_a: Address::ZERO,
            ..fixture_params()
        };
        let mirror_state = fixture_mirror();
        let selection = charge_fees(&fixture_orders(), &params, &mirror_state).unwrap();
        let built = build_leg(&selection, &params, &mirror_state, 0, 1).unwrap();

        let credits = Vec::<abi::Credit>::abi_decode(&built.leg.distribution).unwrap();
        assert_eq!(credits.len(), 1, "only the residual side is distributed");
        assert_eq!(credits[0].amount, selection.orders[0].net_in);
        assert_eq!(credits[0].recipient, selection.orders[0].order.recipient);
    }

    #[test]
    fn ct9_an_empty_band_is_refused_before_any_l1_call() {
        // A sells 1 A demanding 3000 B; B sells 3000 B demanding 1.5 A. No
        // price satisfies both.
        let orders = vec![
            order(
                1,
                Side::SellAForB,
                "1000000000000000000",
                "3000000000000000000000",
            ),
            order(
                2,
                Side::SellBForA,
                "3000000000000000000000",
                "1500000000000000000",
            ),
        ];
        let params = fixture_params();
        let selection = charge_fees(&orders, &params, &fixture_mirror()).unwrap();
        let error = build_leg(&selection, &params, &fixture_mirror(), 0, 1).unwrap_err();
        assert!(matches!(error, WindowError::EmptyPriceBand { .. }));

        // And the two orders that set the ends are exactly the two candidates
        // for the drop that relaxes it.
        assert_eq!(
            binding_orders(&selection, BandBound::Min),
            vec![orders[0].id]
        );
        assert_eq!(
            binding_orders(&selection, BandBound::Max),
            vec![orders[1].id]
        );
    }

    #[test]
    fn ct9_an_order_without_a_limit_bounds_nothing() {
        let orders = vec![order(1, Side::SellAForB, "1000000000000000000", "0")];
        let params = fixture_params();
        let selection = charge_fees(&orders, &params, &fixture_mirror()).unwrap();
        let (min, max) = price_band(&selection).unwrap();
        assert_eq!(min, U256::ZERO);
        assert_eq!(max, U256::MAX);
        assert!(binding_orders(&selection, BandBound::Min).is_empty());
    }

    #[test]
    fn ct7_select_drops_expired_ids_and_duplicates_and_orders_ascending() {
        let mut orders = fixture_orders();
        orders.push(order(3, Side::SellAForB, "1000000000000000000", "0"));
        orders[2].expires_after = 0;
        orders[2].placed_window = 0;
        let duplicated: Vec<Order> = orders.iter().rev().chain(orders.iter()).cloned().collect();

        // Window 4: orders 1 and 2 live to `0 + 4`, order 3 expired at `0 + 0`.
        let selected = select(&duplicated, 4);
        assert_eq!(
            selected.iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![OrderId::with_last_byte(1), OrderId::with_last_byte(2)],
            "expired dropped, duplicates collapsed, ascending by id"
        );
    }

    #[test]
    fn fl5_crossed_orders_clear_at_p0_and_the_residual_side_alone_pays_impact() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let selection = charge_fees(&fixture_orders(), &params, &mirror_state).unwrap();
        let built = build_leg(&selection, &params, &mirror_state, 0, 1).unwrap();

        // A leg that executes below `P0`: the residual sold A into the curve.
        let p0 = mirror::spot_price_x96(&mirror_state).unwrap();
        let amount_out =
            mirror::quote(&mirror_state, built.leg.residual_in, Side::SellAForB).unwrap();
        let result = WindowResult {
            amount_in: built.leg.residual_in,
            amount_out,
            reference_price_x96: p0,
            execution_price_x96: mul_div(amount_out, Q96, built.leg.residual_in).unwrap(),
            post: mirror_state,
            l1_block: 1,
        };

        let fills = distribute(&selection, &built, &result).unwrap();
        assert_eq!(fills.len(), 2);

        let alice = &fills[0];
        let bob = &fills[1];
        assert!(!alice.crossed, "the A side is the residual here");
        assert!(bob.crossed);
        assert_eq!(
            bob.impact_amount,
            U256::ZERO,
            "crossed volume never pays impact"
        );
        assert!(
            alice.impact_amount > U256::ZERO,
            "the residual side bears it"
        );
        // The crossed side clears at the price the window netted at, which is
        // `P0` here because the head has not moved off the mirror — the steady
        // state CT-9 describes. Rounding the crossed output down shows up as a
        // price a hair the other side of `P0`, never as a different price.
        let epsilon = U256::from(10u8).pow(U256::from(16u8));
        assert!(
            bob.price_x96.abs_diff(p0) < epsilon,
            "a crossed fill clears at P0"
        );
        assert!(alice.price_x96 < p0, "the residual fill paid the impact");

        // CT-12: Σ outputs never exceeds the leg's output plus crossed volume.
        assert!(alice.amount_out <= selection.sum_b + result.amount_out);
        assert!(bob.amount_out <= built.cross_pot);
    }

    #[test]
    fn ct2_a_leg_with_no_reference_price_is_malformed() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let selection = charge_fees(&fixture_orders(), &params, &mirror_state).unwrap();
        let built = build_leg(&selection, &params, &mirror_state, 0, 1).unwrap();
        let result = WindowResult {
            amount_in: U256::ZERO,
            amount_out: U256::ZERO,
            reference_price_x96: U256::ZERO,
            execution_price_x96: U256::ZERO,
            post: mirror_state,
            l1_block: 1,
        };
        assert_eq!(
            distribute(&selection, &built, &result),
            Err(WindowError::MalformedResult)
        );
    }

    #[test]
    fn ct12_a_fee_that_consumes_the_order_is_refused_by_id() {
        let params = BookParams {
            fee: BookFee::Fixed {
                a: U256::from(10u8).pow(U256::from(19u8)),
                b: U256::ZERO,
            },
            ..fixture_params()
        };
        let error = charge_fees(&fixture_orders(), &params, &fixture_mirror()).unwrap_err();
        assert_eq!(
            error,
            WindowError::FeeExceedsOrder(b256!(
                "0000000000000000000000000000000000000000000000000000000000000001"
            ))
        );
    }

    #[test]
    fn ec1_the_recover_route_fee_splits_pro_rata_by_size() {
        let params = BookParams {
            asset_a: Address::ZERO, // A is native zone ETH, so wei is A's unit
            route_fee: BookRouteFee::Recover(U256::from(3_000_000u32)),
            ..fixture_params()
        };
        let selection = charge_fees(&fixture_orders(), &params, &fixture_mirror()).unwrap();

        // Valued in A, the A-side order is 10 and the B-side one 5, so the
        // 3,000,000 wei splits two-to-one — and each share is then charged in
        // its own sell asset (CT-12).
        let price = mirror::spot_price_x96(&fixture_mirror()).unwrap();
        assert_eq!(selection.orders[0].route_fee, U256::from(2_000_000u32));
        assert_eq!(
            selection.orders[1].route_fee,
            mul_div(U256::from(1_000_000u32), price, Q96).unwrap()
        );

        // The whole route fee is recovered, to the wei the split rounds away.
        let in_a = selection.orders[0].route_fee
            + mul_div(selection.orders[1].route_fee, Q96, price).unwrap();
        assert!(U256::from(3_000_000u32).abs_diff(in_a) <= U256::from(1u8));
    }

    #[test]
    fn a5_gross_is_measured_in_a_for_the_netting_ratio() {
        let params = fixture_params();
        let mirror_state = fixture_mirror();
        let selection = charge_fees(&fixture_orders(), &params, &mirror_state).unwrap();
        let price = mirror::spot_price_x96(&mirror_state).unwrap();
        let gross = selection.gross_in_a(price).unwrap();
        // Two roughly equal sides: gross is about twice the residual, so the
        // window nets about half its volume away.
        let built = build_leg(&selection, &params, &mirror_state, 0, 1).unwrap();
        assert!(built.leg.residual_in * U256::from(2u8) <= gross + U256::from(2u8));
    }
}
