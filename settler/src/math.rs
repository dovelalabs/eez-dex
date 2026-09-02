//! Q96 fixed-point arithmetic, matching the contracts to the wei.
//!
//! Every price in this repository is **B per A in Q96 regardless of `Side`**,
//! and all price arithmetic goes through `mulDiv` (RD-2 A.1, CT-2). The
//! contracts use OpenZeppelin's `Math.mulDiv`, which computes `a * b / d` over
//! a full 512-bit intermediate; [`mul_div`] and [`mul_div_ceil`] here are that
//! same function, so an off-chain figure and its on-chain twin agree exactly
//! rather than nearly (TS-3 leg parity).
//!
//! A division whose quotient does not fit in 256 bits is an error rather than a
//! wrap: on-chain the same input reverts, and a settler that silently produced
//! a wrapped number would be suggesting a selection the contract cannot honour.

use alloy_primitives::{U256, U512};

/// `2**96`. Every price in this repository is Q96.
///
/// Bit 96 lives in the second 64-bit limb, 32 bits up.
pub const Q96: U256 = U256::from_limbs([0, 1 << 32, 0, 0]);

/// One L1 slot, in seconds. The zone produces six blocks inside it (RD-2 §1).
pub const L1_SLOT_SECONDS: u64 = 12;

/// Basis points denominator, matching `WindowBook.BPS_DENOMINATOR` (EC-1).
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Why a fixed-point operation could not produce an answer the chain would
/// also produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MathError {
    /// The divisor was zero; on-chain the same input panics.
    #[error("division by zero")]
    DivisionByZero,
    /// The quotient does not fit in 256 bits; on-chain `mulDiv` reverts.
    #[error("the quotient does not fit in 256 bits")]
    Overflow,
}

/// `a * b / d`, rounded down, over a full 512-bit intermediate.
///
/// This is OpenZeppelin's `Math.mulDiv(a, b, d)`.
pub fn mul_div(a: U256, b: U256, d: U256) -> Result<U256, MathError> {
    if d.is_zero() {
        return Err(MathError::DivisionByZero);
    }
    let quotient = (U512::from(a) * U512::from(b)) / U512::from(d);
    narrow(quotient)
}

/// `a * b / d`, rounded up — `Math.mulDiv(a, b, d, Math.Rounding.Ceil)`.
///
/// The price band's sell-side bound rounds up so that the price it demands is
/// the one that leaves the user their limit rather than one wei short (CT-9).
pub fn mul_div_ceil(a: U256, b: U256, d: U256) -> Result<U256, MathError> {
    if d.is_zero() {
        return Err(MathError::DivisionByZero);
    }
    let product = U512::from(a) * U512::from(b);
    let divisor = U512::from(d);
    let quotient = product.div_ceil(divisor);
    narrow(quotient)
}

/// `a * b`, where the product must fit in 256 bits — Solidity 0.8's checked
/// multiplication, which reverts rather than wrapping.
pub fn checked_mul(a: U256, b: U256) -> Result<U256, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

fn narrow(wide: U512) -> Result<U256, MathError> {
    let limbs = wide.into_limbs();
    if limbs[4..].iter().any(|limb| *limb != 0) {
        return Err(MathError::Overflow);
    }
    Ok(U256::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3]]))
}

/// The `sqrtPriceX96` a pool would carry to price at `price_x96` — the inverse
/// of `Mirror.spotPriceX96`.
///
/// The reconciler's EC-4 audit needs the pool *as the leg found it*: what it
/// has is the settled `P0`, and what the simulator wants is a `PoolState`. The
/// root is rounded **up**, because `spotPriceX96` squares and then truncates,
/// so a floor root would price one wei light and the audit would recompute
/// against a slightly different pool than the one that settled.
pub fn sqrt_price_from_price_x96(price_x96: U256) -> U256 {
    let target = U512::from(price_x96) << 96usize;
    if target.is_zero() {
        return U256::ZERO;
    }
    let mut guess = U512::from(1u8) << target.bit_len().div_ceil(2);
    loop {
        let next = (guess + target / guess) >> 1usize;
        if next >= guess {
            break;
        }
        guess = next;
    }
    let root = if guess * guess < target {
        guess + U512::from(1u8)
    } else {
        guess
    };
    narrow(root).unwrap_or(U256::MAX)
}

/// The mirror's age in L1 slots: `(timestamp - mirror_timestamp) / 12`.
///
/// The L1 head is not visible from L2 and the Sync block's timestamp equals the
/// pinned L1 slot time, so this is the only age there is (CT-8). A mirror
/// stamped in the future ages to zero rather than underflowing, exactly as
/// `Mirror.ageSlots` does.
pub fn age_slots(timestamp: u64, mirror_timestamp: u64) -> u32 {
    if mirror_timestamp == 0 || timestamp <= mirror_timestamp {
        return 0;
    }
    u32::try_from((timestamp - mirror_timestamp) / L1_SLOT_SECONDS).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q96_is_two_to_the_ninety_six() {
        assert_eq!(Q96, U256::from(1u8) << 96);
    }

    #[test]
    fn mul_div_uses_a_full_width_intermediate() {
        // `U256::MAX * 2 / 4` overflows any 256-bit intermediate but not a
        // 512-bit one, which is the whole point of `mulDiv`.
        let half = mul_div(U256::MAX, U256::from(2u8), U256::from(4u8)).unwrap();
        assert_eq!(half, U256::MAX / U256::from(2u8));
    }

    #[test]
    fn mul_div_ceil_rounds_the_other_way() {
        let (a, b, d) = (U256::from(7u8), U256::from(1u8), U256::from(2u8));
        assert_eq!(mul_div(a, b, d).unwrap(), U256::from(3u8));
        assert_eq!(mul_div_ceil(a, b, d).unwrap(), U256::from(4u8));
        // An exact division rounds to itself in both directions.
        let (a, d) = (U256::from(8u8), U256::from(2u8));
        assert_eq!(mul_div_ceil(a, b, d).unwrap(), U256::from(4u8));
    }

    #[test]
    fn a_quotient_wider_than_256_bits_is_an_error_not_a_wrap() {
        assert_eq!(
            mul_div(U256::MAX, U256::from(2u8), U256::from(1u8)),
            Err(MathError::Overflow)
        );
        assert_eq!(
            mul_div(U256::from(1u8), U256::from(1u8), U256::ZERO),
            Err(MathError::DivisionByZero)
        );
    }

    #[test]
    fn ec4_the_square_root_inverts_the_mirrors_spot_price() {
        for price in [1u64, 1_900, 2_000, 2_100, 4_000_000] {
            let price_x96 = U256::from(price) << 96usize;
            let sqrt = sqrt_price_from_price_x96(price_x96);
            // `spotPriceX96` is `mulDiv(sqrt, sqrt, Q96)`; rounding the root up
            // is what keeps the round trip on the price rather than one under.
            assert_eq!(
                mul_div(sqrt, sqrt, Q96).unwrap() / Q96,
                U256::from(price),
                "sqrt_price_from_price_x96({price}) must price at {price}"
            );
        }
        assert_eq!(sqrt_price_from_price_x96(U256::ZERO), U256::ZERO);
    }

    #[test]
    fn ct8_mirror_age_is_whole_slots_and_never_underflows() {
        assert_eq!(age_slots(1_800_000_000, 1_800_000_000), 0);
        assert_eq!(age_slots(1_800_000_011, 1_800_000_000), 0);
        assert_eq!(age_slots(1_800_000_012, 1_800_000_000), 1);
        assert_eq!(age_slots(1_800_000_071, 1_800_000_000), 5);
        // A mirror stamped in the future, and one never stamped at all.
        assert_eq!(age_slots(1_800_000_000, 1_800_000_120), 0);
        assert_eq!(age_slots(1_800_000_000, 0), 0);
    }
}
