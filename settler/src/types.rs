//! The shared types of RD-2 appendix A.1, in Rust.
//!
//! `contracts/src/types/Types.sol` is the normative copy and is frozen; these
//! are its Rust twins, field for field, so that a `WindowLeg` the builder
//! derives and one `WindowBook.settleWindow` builds are comparable without
//! translation (TS-3 leg parity).
//!
//! **The settler never constructs a `WindowLeg` to send.** It derives one to
//! *predict* what the contract will build from a set of order ids, because
//! predicting it is how the fillable subset is chosen (FL-8). What goes on the
//! wire is `settleWindow(bytes32[] orderIds, uint64 deadline)` and nothing
//! else (CT-9).

use alloy_primitives::{Address, B256, U256};

/// A.1's `Side`. Prices are B per A in Q96 regardless of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Side {
    /// Sell A (the pool's `token0`) for B.
    SellAForB,
    /// Sell B (the pool's `token1`) for A.
    SellBForA,
}

impl Side {
    /// The other side of the book.
    pub fn opposite(self) -> Self {
        match self {
            Self::SellAForB => Self::SellBForA,
            Self::SellBForA => Self::SellAForB,
        }
    }

    /// True when this side sells A — the orientation every amount comparison
    /// in the window arithmetic turns on.
    pub fn sells_a(self) -> bool {
        matches!(self, Self::SellAForB)
    }

    /// The `Side` enum's on-chain ordinal.
    pub fn as_u8(self) -> u8 {
        match self {
            Self::SellAForB => 0,
            Self::SellBForA => 1,
        }
    }

    /// The IX-2 wire name, which is the enum's name rather than its ordinal so
    /// a recorded run stays readable.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SellAForB => "SELL_A_FOR_B",
            Self::SellBForA => "SELL_B_FOR_A",
        }
    }
}

/// An order id: `keccak256(owner, nonce)`, derived on-chain and never
/// user-supplied (CT-7).
///
/// Ascending id order is the settler's canonical order. Ties and drop order
/// resolve by it, which is what makes two settlers with the same inputs
/// produce the same selection (SV-2).
pub type OrderId = B256;

/// A.1's `Order`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    /// `keccak256(owner, nonce)`.
    pub id: OrderId,
    /// Who placed it.
    pub owner: Address,
    /// Which way it trades.
    pub side: Side,
    /// The escrowed input, gross of fees.
    pub sell_amount: U256,
    /// The limit, net of fees and impact. Never filled below this (CT-10).
    pub min_buy_amount: U256,
    /// An L2 address \[full\] or an L1 address \[genesis\].
    pub recipient: Address,
    /// Lifetime in windows.
    pub expires_after: u32,
    /// The window the order was placed in; it expires after `expires_after`
    /// more. Not an A.1 field — the book stores it in `placedWindow` — but the
    /// settler needs it to drop an expired order exactly as `_select` does.
    pub placed_window: u64,
}

impl Order {
    /// Whether the order has expired as of `window`, matching
    /// `WindowBook._isExpired`: `window > placedWindow + expiresAfter`, so an
    /// order placed in window *w* with `expiresAfter = n` is alive through
    /// window *w + n* and expired in *w + n + 1*.
    pub fn is_expired(&self, window: u64) -> bool {
        window
            > self
                .placed_window
                .saturating_add(u64::from(self.expires_after))
    }
}

/// A.1's `PoolState`: what the mirror is a working copy of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolState {
    /// uint160.
    pub sqrt_price_x96: U256,
    /// uint128.
    pub liquidity: u128,
    /// int24.
    pub tick: i32,
}

/// A.1's `WindowLeg`, as the contract will build it (CT-9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowLeg {
    /// The window this leg settles.
    pub window_id: u64,
    /// Which way the net demand trades.
    pub residual_side: Side,
    /// Net amount to swap on L1 after crossing. Zero in a CT-6 refresh.
    pub residual_in: U256,
    /// The tightest sell-side limit among the selected orders.
    pub min_price_x96: U256,
    /// The tightest buy-side limit among them.
    pub max_price_x96: U256,
    /// A unix timestamp, checked on L1 against `block.timestamp` (CT-1).
    pub deadline: u64,
    /// \[genesis\] abi-encoded `(recipient, sellAmount)[]`; empty \[full\].
    pub distribution: Vec<u8>,
}

/// A.1's `WindowResult` — what the L1 leg returned and the composer recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowResult {
    /// The residual actually swapped.
    pub amount_in: U256,
    /// What the swap bought.
    pub amount_out: U256,
    /// `P0`: the pre-trade spot read inside the leg. Crossed fills clear here.
    pub reference_price_x96: U256,
    /// The residual's realised average price.
    pub execution_price_x96: U256,
    /// The pool after the swap; becomes the next mirror.
    pub post: PoolState,
    /// The L1 block the leg executed in.
    pub l1_block: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a1_side_ordinals_match_the_solidity_enum() {
        assert_eq!(Side::SellAForB.as_u8(), 0);
        assert_eq!(Side::SellBForA.as_u8(), 1);
        assert_eq!(Side::SellAForB.opposite(), Side::SellBForA);
        assert!(Side::SellAForB.sells_a());
        assert!(!Side::SellBForA.sells_a());
    }

    #[test]
    fn ix2_side_travels_by_name_not_by_ordinal() {
        assert_eq!(Side::SellAForB.as_str(), "SELL_A_FOR_B");
        assert_eq!(Side::SellBForA.as_str(), "SELL_B_FOR_A");
    }

    #[test]
    fn ct7_expiry_matches_the_books_window_arithmetic() {
        let order = Order {
            id: OrderId::ZERO,
            owner: Address::ZERO,
            side: Side::SellAForB,
            sell_amount: U256::from(1u8),
            min_buy_amount: U256::ZERO,
            recipient: Address::ZERO,
            expires_after: 2,
            placed_window: 7,
        };
        assert!(!order.is_expired(7));
        assert!(!order.is_expired(9), "placed in 7, alive through 7 + 2");
        assert!(order.is_expired(10));
    }
}
