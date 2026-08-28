//! Fixtures the crate's own tests share.
//!
//! The leg-parity fixture (`contracts/test/l2/fixtures/leg-parity.json`) is the
//! one WP-2 asserts its on-chain construction against, so building it in one
//! place keeps the two sides comparing the same numbers (TS-1, TS-3).
//!
//! Compiled only under `cfg(test)`.

use alloy_primitives::{Address, U256};

use crate::types::{Order, OrderId, PoolState, Side};
use crate::window::{BookFee, BookParams, BookProfile, BookRouteFee};

/// A decimal amount, as the fixtures write them.
pub fn wei(decimal: &str) -> U256 {
    decimal.parse().expect("a decimal amount")
}

/// The fixture's book: full profile, 1 bp, route fee absorbed (EC-1).
pub fn fixture_params() -> BookParams {
    BookParams {
        profile: BookProfile::Full,
        asset_a: Address::with_last_byte(0xa0),
        asset_b: Address::with_last_byte(0xb0),
        fee: BookFee::Bps(1),
        route_fee: BookRouteFee::Absorb,
    }
}

/// The fixture's mirror: 1000 A against 2,000,000 B, so 2000 B per A.
pub fn fixture_mirror() -> PoolState {
    PoolState {
        sqrt_price_x96: wei("3543191142285914205922034323214"),
        liquidity: 44_721_359_549_995_793_928_183,
        tick: 0,
    }
}

/// A pool at `price` B per A with the fixture's depth — the L1 head after a
/// drift, for the tests that move it out from under the mirror (FL-8).
pub fn pool_at(price_b_per_a: u64) -> PoolState {
    // sqrtPriceX96 = sqrt(price) * 2**96, to the wei integer square roots allow.
    let price_x96 = U256::from(price_b_per_a) << 96usize;
    PoolState {
        sqrt_price_x96: sqrt_x96(price_x96),
        ..fixture_mirror()
    }
}

/// `ceil(sqrt(price_x96 * 2**96))` by Newton's method — the inverse of the
/// mirror's `spotPriceX96`.
///
/// Rounded **up**, because `spotPriceX96` squares and then truncates: a floor
/// square root comes back one wei light and `pool_at(2000)` would price at
/// 1999.
fn sqrt_x96(price_x96: U256) -> U256 {
    let target = price_x96 << 96usize;
    if target.is_zero() {
        return U256::ZERO;
    }
    let mut guess = U256::from(1u8) << (target.bit_len()).div_ceil(2);
    loop {
        let next = (guess + target / guess) >> 1usize;
        if next >= guess {
            break;
        }
        guess = next;
    }
    if guess * guess < target {
        guess + U256::from(1u8)
    } else {
        guess
    }
}

/// An order with the shape the fixtures use. `expires_after` is generous so
/// expiry is never an accidental variable in a selection test.
pub fn order(id: u8, side: Side, sell: &str, min_buy: &str) -> Order {
    Order {
        id: OrderId::with_last_byte(id),
        owner: Address::with_last_byte(id),
        side,
        sell_amount: wei(sell),
        min_buy_amount: wei(min_buy),
        recipient: Address::with_last_byte(id),
        expires_after: 4,
        placed_window: 0,
    }
}

/// The fixture's two orders: alice sells 10 A at a 19,000 B limit, bob sells
/// 10,000 B at a 4.9 A limit.
pub fn fixture_orders() -> Vec<Order> {
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

/// A seeded xorshift64\* generator.
///
/// Determinism is load-bearing (SV-2), so a property test that used a random
/// seed would be a test whose failures could not be reproduced. Same seed,
/// same cases, every run and every machine.
#[derive(Debug, Clone, Copy)]
pub struct Rng(u64);

impl Rng {
    /// A generator seeded with `seed`. Zero is replaced: xorshift is stuck there.
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9e37_79b9_7f4a_7c15
        } else {
            seed
        })
    }

    /// The next 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A value in `low ..= high`.
    pub fn in_range(&mut self, low: u64, high: u64) -> u64 {
        debug_assert!(low <= high);
        low + self.next_u64() % (high - low + 1)
    }

    /// `slice`, shuffled in place — the permutations SV-2's property test runs
    /// the same input set through.
    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        for i in (1..slice.len()).rev() {
            let j = (self.next_u64() % (i as u64 + 1)) as usize;
            slice.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Q96;
    use crate::mirror;

    #[test]
    fn pool_at_prices_where_it_says_it_does() {
        for price in [1u64, 1900, 2000, 2100, 4_000_000] {
            let priced = mirror::spot_price_x96(&pool_at(price)).unwrap() / Q96;
            assert_eq!(
                priced,
                U256::from(price),
                "pool_at({price}) must price at {price}"
            );
        }
    }

    #[test]
    fn the_rng_is_seeded_so_a_failure_can_be_reproduced() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        assert_eq!(a.next_u64(), b.next_u64());
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());

        let mut left = [1, 2, 3, 4, 5, 6, 7, 8];
        let mut right = left;
        Rng::new(42).shuffle(&mut left);
        Rng::new(42).shuffle(&mut right);
        assert_eq!(left, right);
        let mut sorted = left;
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            [1, 2, 3, 4, 5, 6, 7, 8],
            "a shuffle is a permutation"
        );
    }

    #[test]
    fn in_range_stays_inside_its_bounds() {
        let mut rng = Rng::new(1);
        for _ in 0..1000 {
            let value = rng.in_range(5, 9);
            assert!((5..=9).contains(&value));
        }
        assert_eq!(rng.in_range(3, 3), 3);
    }
}
