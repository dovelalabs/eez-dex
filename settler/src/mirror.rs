//! The mirror's pricing maths — the Rust half of `contracts/src/l2/Mirror.sol`.
//!
//! RD-2 §3 says the `Mirror` library is "the same quote and clearing-price
//! maths shared with the settler's simulator", so this is a transcription
//! rather than a reimplementation: the same curve, the same rounding, the same
//! order of operations. An off-chain quote that drifted from the on-chain one
//! would put the settler's selection at odds with the leg the contract builds,
//! which is the one failure mode FL-8 exists to prevent.
//!
//! **Orientation.** A is the pool's `token0` and B its `token1`, so a price is
//! B per A in Q96 regardless of `Side` (A.1).
//!
//! What is modelled is the constant-product curve of a v3 range that spans
//! every price — what `MockPool` (HX-1) implements and what a real pool does
//! inside one tick. A quote from it is indicative (FL-2); the binding price is
//! always the one the L1 leg returns (CT-2).

use alloy_primitives::U256;

use crate::math::{MathError, Q96, checked_mul, mul_div, mul_div_ceil};
use crate::types::{PoolState, Side};

/// Why a snapshot could not be priced. Each variant is a revert the on-chain
/// library would produce for the same input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MirrorError {
    /// The snapshot carries no price, so nothing can be quoted from it.
    #[error("the mirror snapshot has no price")]
    Uninitialised,
    /// The snapshot has no in-range liquidity, so the curve is undefined.
    #[error("the mirror snapshot has no in-range liquidity")]
    NoLiquidity,
    /// Fixed-point arithmetic that reverts on-chain for the same input.
    #[error("{0}")]
    Math(#[from] MathError),
}

/// The spot price implied by the snapshot: B per A in Q96.
///
/// `(sqrtPriceX96 / 2**96)**2` carried in Q96 — `Mirror.spotPriceX96`. This is
/// the clearing price the window nets at (FL-4).
pub fn spot_price_x96(state: &PoolState) -> Result<U256, MirrorError> {
    if state.sqrt_price_x96.is_zero() {
        return Err(MirrorError::Uninitialised);
    }
    Ok(mul_div(state.sqrt_price_x96, state.sqrt_price_x96, Q96)?)
}

/// Value `amount` of `side`'s sell asset in its buy asset at `price_x96`.
///
/// `Mirror.valueIn`. Prices are B per A regardless of `Side`, so the direction
/// of the division is the only thing `side` selects. Rounds **down** (CT-12).
pub fn value_in(amount: U256, price_x96: U256, side: Side) -> Result<U256, MirrorError> {
    if price_x96.is_zero() {
        return Err(MirrorError::Uninitialised);
    }
    Ok(match side {
        Side::SellAForB => mul_div(amount, price_x96, Q96)?,
        Side::SellBForA => mul_div(amount, Q96, price_x96)?,
    })
}

/// Expected output for `sell_amount` on `side` against `state` — `Mirror.quote`.
pub fn quote(state: &PoolState, sell_amount: U256, side: Side) -> Result<U256, MirrorError> {
    Ok(advance(state, sell_amount, side)?.1)
}

/// The same swap as [`quote`], plus the state it leaves behind — `Mirror.advance`.
///
/// This is the simulator half of the mirror: the settler runs it against the L1
/// head to derive the clearing price and select the fillable subset (SV-2), and
/// it is why an on-chain quote and an off-chain one cannot drift. `post.tick`
/// is carried through unchanged — nothing in the DEX prices from the tick, and
/// the real one comes back in `WindowResult` (CT-2).
pub fn advance(
    state: &PoolState,
    sell_amount: U256,
    side: Side,
) -> Result<(PoolState, U256), MirrorError> {
    if state.sqrt_price_x96.is_zero() {
        return Err(MirrorError::Uninitialised);
    }
    let mut post = *state;
    if sell_amount.is_zero() {
        return Ok((post, U256::ZERO));
    }
    if state.liquidity == 0 {
        return Err(MirrorError::NoLiquidity);
    }

    let liquidity = U256::from(state.liquidity);
    let sqrt_p = state.sqrt_price_x96;
    let amount_out;

    match side {
        Side::SellAForB => {
            // A (token0) in: the price falls to L*sqrtP / (L + amountIn*sqrtP/Q96).
            let sqrt_next = next_price_a_in(sqrt_p, liquidity, sell_amount)?;
            // token1 out between two prices: L * (sqrtP - sqrtNext) / Q96.
            amount_out = mul_div(liquidity, sqrt_p - sqrt_next, Q96)?;
            post.sqrt_price_x96 = sqrt_next;
        }
        Side::SellBForA => {
            // B (token1) in: the price rises by amountIn * Q96 / L.
            let sqrt_next = sqrt_p + mul_div(sell_amount, Q96, liquidity)?;
            // token0 out: L * Q96 * (sqrtNext - sqrtP) / (sqrtNext * sqrtP), as
            // the contract writes it — one `mulDiv` and then a plain division,
            // so the two truncations land in the same places.
            amount_out = mul_div(liquidity << 96usize, sqrt_next - sqrt_p, sqrt_next)? / sqrt_p;
            post.sqrt_price_x96 = sqrt_next;
        }
    }

    Ok((post, amount_out))
}

/// `sqrtP' = L * sqrtP / (L + amountIn * sqrtP / Q96)`, rounded up so the
/// output that follows rounds down — `Mirror._nextPriceAIn`.
///
/// The library carries an overflow-safe fallback for `amountIn * sqrtP`, but
/// under Solidity 0.8's checked arithmetic that multiplication reverts before
/// the guard can be read, so the fallback is unreachable on-chain. Reaching it
/// here would mean answering where the chain reverts, so this returns the same
/// overflow instead.
fn next_price_a_in(sqrt_p: U256, liquidity: U256, amount_in: U256) -> Result<U256, MirrorError> {
    let numerator = liquidity << 96usize;
    let product = checked_mul(amount_in, sqrt_p)?;
    let denominator = numerator.checked_add(product).ok_or(MathError::Overflow)?;
    Ok(mul_div_ceil(numerator, sqrt_p, denominator)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The leg-parity fixture's mirror: 1000 A and 2,000,000 B, so 2000 B per A.
    fn fixture_mirror() -> PoolState {
        PoolState {
            sqrt_price_x96: "3543191142285914205922034323214".parse().unwrap(),
            liquidity: 44_721_359_549_995_793_928_183,
            tick: 0,
        }
    }

    #[test]
    fn fl1_spot_price_matches_the_leg_parity_fixture() {
        let expected: U256 = "158456325028528675187087900671953".parse().unwrap();
        assert_eq!(spot_price_x96(&fixture_mirror()).unwrap(), expected);
        // The fixture's pool holds 1000 A against 2,000,000 B, so the price is
        // 2000 B per A up to the sqrt price's own truncation.
        assert_eq!(expected / Q96, U256::from(1999u16));
    }

    #[test]
    fn ct12_value_in_rounds_down_on_both_sides() {
        let price = spot_price_x96(&fixture_mirror()).unwrap();
        let one_a = U256::from(10u8).pow(U256::from(18u8));
        let two_thousand_b = U256::from(2000u16) * one_a;

        // 1 A is worth ~2000 B, and rounding is *down*: never a wei more.
        let in_b = value_in(one_a, price, Side::SellAForB).unwrap();
        assert!(in_b <= two_thousand_b && in_b > two_thousand_b - U256::from(1_000_000u32));

        let in_a = value_in(two_thousand_b, price, Side::SellBForA).unwrap();
        assert!(in_a <= one_a && in_a > one_a - U256::from(1_000_000u32));

        // Valuing at a price is not a swap: it never crosses the curve, so a
        // round trip loses only the two truncations.
        let back = value_in(in_b, price, Side::SellBForA).unwrap();
        assert!(back <= one_a && one_a - back <= U256::from(1u8));
    }

    #[test]
    fn an_unpriced_or_illiquid_snapshot_fails_the_way_the_library_reverts() {
        let empty = PoolState {
            sqrt_price_x96: U256::ZERO,
            liquidity: 1,
            tick: 0,
        };
        assert_eq!(spot_price_x96(&empty), Err(MirrorError::Uninitialised));
        assert_eq!(
            advance(&empty, U256::from(1u8), Side::SellAForB),
            Err(MirrorError::Uninitialised)
        );

        let dry = PoolState {
            liquidity: 0,
            ..fixture_mirror()
        };
        assert_eq!(
            advance(&dry, U256::from(1u8), Side::SellAForB),
            Err(MirrorError::NoLiquidity)
        );
        // A zero-amount advance reads the snapshot rather than pricing it, so
        // it answers even without liquidity — as the library does.
        assert_eq!(
            advance(&dry, U256::ZERO, Side::SellAForB).unwrap().1,
            U256::ZERO
        );
    }

    #[test]
    fn sv2_the_curve_moves_the_price_against_the_swap_on_both_sides() {
        let state = fixture_mirror();
        let one_a = U256::from(10u8).pow(U256::from(18u8));

        let (post, out) = advance(&state, one_a, Side::SellAForB).unwrap();
        assert!(out > U256::ZERO);
        assert!(
            post.sqrt_price_x96 < state.sqrt_price_x96,
            "selling A moves B/A down"
        );
        // Impact is real: a curve trade buys less than the spot valuation.
        assert!(out < value_in(one_a, spot_price_x96(&state).unwrap(), Side::SellAForB).unwrap());

        let two_thousand_b = U256::from(2000u16) * one_a;
        let (post, out) = advance(&state, two_thousand_b, Side::SellBForA).unwrap();
        assert!(out > U256::ZERO);
        assert!(
            post.sqrt_price_x96 > state.sqrt_price_x96,
            "selling B moves B/A up"
        );
        assert!(out < one_a);
    }

    #[test]
    fn sv2_advance_never_moves_the_snapshot_it_was_asked_to_read() {
        let state = fixture_mirror();
        let before = state;
        let _ = advance(
            &state,
            U256::from(10u8).pow(U256::from(18u8)),
            Side::SellAForB,
        )
        .unwrap();
        assert_eq!(state, before);
    }

    #[test]
    fn ct2_the_tick_is_carried_through_untouched() {
        let state = PoolState {
            tick: -12_345,
            ..fixture_mirror()
        };
        let (post, _) = advance(
            &state,
            U256::from(10u8).pow(U256::from(18u8)),
            Side::SellAForB,
        )
        .unwrap();
        assert_eq!(post.tick, -12_345);
        assert_eq!(post.liquidity, state.liquidity);
    }
}
