//! Fixtures the crate's own tests share.
//!
//! The leg-parity fixture (`contracts/test/l2/fixtures/leg-parity.json`) is the
//! one WP-2 asserts its on-chain construction against, so building it in one
//! place keeps the two sides comparing the same numbers (TS-1, TS-3).
//!
//! Compiled only under `cfg(test)`.

use std::collections::BTreeMap;

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
        sqrt_price_x96: crate::math::sqrt_price_from_price_x96(price_x96),
        ..fixture_mirror()
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

// --- fake chains -------------------------------------------------------------
//
// TS-3 drives the whole service — selection, submission, reconciliation — with
// no chain behind it. That is only possible because every chain access is a
// trait (SV-1); these are the implementations the tests hand the tasks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use alloy_primitives::B256;

use crate::chain::{
    BookEvent, ChainError, ChainWindow, Front, FrontStatus, GasParams, HeadInfo, L1Reader,
    L1Receipt, L2Reader, SettlementSigner, SignedSettlement,
};
use crate::config::Config;
use crate::state::StateStore;

/// A store built from the fixture configuration: `WINDOW_HALT=2`,
/// `FLOW_THRESHOLD=4`, `MIRROR_REFRESH_AGE=5`, the EC-1 launch fee.
pub fn store() -> StateStore {
    StateStore::open(&fixture_config())
}

/// The fixture configuration.
pub fn fixture_config() -> Config {
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

#[derive(Debug, Default)]
struct FakeL2Inner {
    window: Option<ChainWindow>,
    events: Vec<BookEvent>,
    open: Vec<Order>,
    drift: BTreeMap<Address, i128>,
    safe_block: u64,
    head_timestamp: u64,
    canonical: BTreeMap<B256, bool>,
    nonce: u64,
}

/// A `WindowBook` that answers from memory.
#[derive(Debug, Clone, Default)]
pub struct FakeL2(Rc<RefCell<FakeL2Inner>>);

impl FakeL2 {
    /// A book with the fixture's parameters and nothing in it.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the open window and its mirror.
    pub fn set_window(
        &self,
        id: u64,
        slots: u8,
        start_block: u64,
        mirror: PoolState,
        mirror_timestamp: u64,
    ) {
        self.0.borrow_mut().window = Some(ChainWindow {
            id,
            slots,
            start_block,
            mirror,
            mirror_timestamp,
            reference_price_x96: crate::mirror::spot_price_x96(&mirror).unwrap_or(U256::ZERO),
            reference_l1_block: 999,
        });
    }

    /// Appends a log the watcher will read.
    pub fn push_event(&self, event: BookEvent) {
        self.0.borrow_mut().events.push(event);
    }

    /// Sets what `openOrderIds` seeds the store with.
    pub fn set_open_orders(&self, orders: Vec<Order>) {
        self.0.borrow_mut().open = orders;
    }

    /// Sets CT-13's drift for one asset.
    pub fn set_escrow_drift(&self, asset: Address, drift: i128) {
        self.0.borrow_mut().drift.insert(asset, drift);
    }

    /// Sets the L2 safe head's block number.
    pub fn set_safe_block(&self, block: u64) {
        self.0.borrow_mut().safe_block = block;
    }

    /// Sets the L2 safe head's timestamp.
    pub fn set_head_timestamp(&self, timestamp: u64) {
        self.0.borrow_mut().head_timestamp = timestamp;
    }

    /// Sets whether a settlement transaction is still in a canonical block.
    pub fn set_canonical(&self, tx_hash: B256, canonical: bool) {
        self.0.borrow_mut().canonical.insert(tx_hash, canonical);
    }

    /// Sets the settler key's next nonce.
    pub fn set_nonce(&self, nonce: u64) {
        self.0.borrow_mut().nonce = nonce;
    }
}

impl L2Reader for FakeL2 {
    fn book_params(&self) -> Result<BookParams, ChainError> {
        Ok(fixture_params())
    }

    fn window(&self) -> Result<ChainWindow, ChainError> {
        self.0
            .borrow()
            .window
            .ok_or_else(|| ChainError::Rpc("the fake book has no window; call set_window".into()))
    }

    fn open_orders(&self) -> Result<Vec<Order>, ChainError> {
        Ok(self.0.borrow().open.clone())
    }

    fn events_since(&self, from_block: u64) -> Result<Vec<BookEvent>, ChainError> {
        Ok(self
            .0
            .borrow()
            .events
            .iter()
            .filter(|event| event.l2_block().is_none_or(|block| block >= from_block))
            .cloned()
            .collect())
    }

    fn safe_head(&self) -> Result<HeadInfo, ChainError> {
        let inner = self.0.borrow();
        Ok(HeadInfo {
            number: inner.safe_block,
            timestamp: if inner.head_timestamp == 0 {
                1_800_000_000
            } else {
                inner.head_timestamp
            },
        })
    }

    fn finalized_head(&self) -> Result<HeadInfo, ChainError> {
        let safe = self.safe_head()?;
        Ok(HeadInfo {
            number: safe.number.saturating_sub(32),
            timestamp: safe.timestamp.saturating_sub(384),
        })
    }

    fn escrow_drift(&self, asset: Address) -> Result<i128, ChainError> {
        Ok(self.0.borrow().drift.get(&asset).copied().unwrap_or(0))
    }

    fn is_canonical(&self, tx_hash: B256) -> Result<bool, ChainError> {
        Ok(self
            .0
            .borrow()
            .canonical
            .get(&tx_hash)
            .copied()
            .unwrap_or(true))
    }

    fn nonce(&self, _settler: Address) -> Result<u64, ChainError> {
        Ok(self.0.borrow().nonce)
    }

    fn gas_params(&self, gas_limit: u64) -> Result<GasParams, ChainError> {
        Ok(GasParams {
            chain_id: 424_242,
            gas_limit,
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        })
    }
}

#[derive(Debug, Default)]
struct FakeL1Inner {
    head: HeadInfo,
    pool: Option<PoolState>,
    receipts: BTreeMap<u64, L1Receipt>,
}

/// An L1 chain and pool that answer from memory. Its `LegSimulator` is the
/// shared `Mirror` maths, which is what the real adapter runs.
#[derive(Debug, Clone, Default)]
pub struct FakeL1(Rc<RefCell<FakeL1Inner>>);

impl FakeL1 {
    /// A head at block 1000 whose pool prices at `price_b_per_a`.
    pub fn at(price_b_per_a: u64) -> Self {
        let fake = Self::default();
        {
            let mut inner = fake.0.borrow_mut();
            inner.head = HeadInfo {
                number: 1_000,
                timestamp: 1_800_000_000,
            };
            inner.pool = Some(pool_at(price_b_per_a));
        }
        fake
    }

    /// Moves the pool mid-window — FL-8's drift.
    pub fn set_price(&self, price_b_per_a: u64) {
        self.0.borrow_mut().pool = Some(pool_at(price_b_per_a));
    }

    /// Sets the head's timestamp, which is what CT-1's deadline is checked
    /// against.
    pub fn set_timestamp(&self, timestamp: u64) {
        self.0.borrow_mut().head.timestamp = timestamp;
    }

    /// Records the receipt of the transaction that carried a leg in an L1
    /// block.
    pub fn set_entry_receipt(&self, l1_block: u64, receipt: L1Receipt) {
        self.0.borrow_mut().receipts.insert(l1_block, receipt);
    }

    /// The simulator the builder runs against this head (SV-2).
    ///
    /// A snapshot: a test that moves the pool afterwards must take a new one.
    /// [`FakeL1`] itself is the live simulator, and that is what the tasks
    /// take, so mid-window drift reaches them the way it reaches `L1Rpc`.
    pub fn simulator(&self) -> crate::selection::MirrorSimulator {
        let inner = self.0.borrow();
        crate::selection::MirrorSimulator {
            head: inner.pool.expect("the fake L1 has a pool"),
            l1_block: inner.head.number,
            l1_timestamp: inner.head.timestamp,
        }
    }
}

impl crate::selection::LegSimulator for FakeL1 {
    fn simulate(
        &self,
        leg: &crate::types::WindowLeg,
    ) -> Result<crate::types::WindowResult, crate::selection::SimulationError> {
        self.simulator().simulate(leg)
    }
}

impl L1Reader for FakeL1 {
    fn head(&self) -> Result<HeadInfo, ChainError> {
        Ok(self.0.borrow().head)
    }

    fn pool_state(&self) -> Result<PoolState, ChainError> {
        self.0
            .borrow()
            .pool
            .ok_or_else(|| ChainError::Rpc("the fake L1 has no pool".into()))
    }

    fn entry_receipt(&self, l1_block: u64) -> Result<Option<L1Receipt>, ChainError> {
        Ok(self.0.borrow().receipts.get(&l1_block).copied())
    }
}

#[derive(Debug)]
struct FakeFrontInner {
    submitted: Vec<B256>,
    status: BTreeMap<B256, FrontStatus>,
    default_status: FrontStatus,
    fail: Option<String>,
    holds: bool,
}

/// An L2->L1 front that records what it was given.
#[derive(Debug, Clone)]
pub struct FakeFront(Rc<RefCell<FakeFrontInner>>);

impl Default for FakeFront {
    fn default() -> Self {
        Self(Rc::new(RefCell::new(FakeFrontInner {
            submitted: Vec::new(),
            status: BTreeMap::new(),
            default_status: FrontStatus::Held,
            fail: None,
            holds: false,
        })))
    }
}

impl FakeFront {
    /// A front that holds everything it is given.
    pub fn new() -> Self {
        Self::default()
    }

    /// Every transaction the front was given, in order — the count SV-3's
    /// "exactly one settlement per window" is asserted on.
    pub fn submitted(&self) -> Vec<B256> {
        self.0.borrow().submitted.clone()
    }

    /// Sets what the front says about a transaction.
    pub fn set_status(&self, tx_hash: B256, status: FrontStatus) {
        self.0.borrow_mut().status.insert(tx_hash, status);
    }

    /// Sets what the front says about anything it was not told about.
    pub fn set_default_status(&self, status: FrontStatus) {
        self.0.borrow_mut().default_status = status;
    }

    /// Makes the next submission fail.
    pub fn fail_with(&self, reason: &str) {
        self.0.borrow_mut().fail = Some(reason.to_string());
    }

    /// Sets whether the front is holding a settlement from the settler key —
    /// what a restarted settler asks before signing anything (SV-5).
    pub fn set_holds_from_settler(&self, holds: bool) {
        self.0.borrow_mut().holds = holds;
    }
}

impl Front for FakeFront {
    fn submit(&self, signed: &[u8]) -> Result<B256, ChainError> {
        let mut inner = self.0.borrow_mut();
        if let Some(reason) = inner.fail.take() {
            return Err(ChainError::Rpc(reason));
        }
        let tx_hash = alloy_primitives::keccak256(signed);
        inner.submitted.push(tx_hash);
        inner.holds = true;
        Ok(tx_hash)
    }

    fn status(&self, tx_hash: B256) -> Result<FrontStatus, ChainError> {
        let inner = self.0.borrow();
        Ok(inner
            .status
            .get(&tx_hash)
            .copied()
            .unwrap_or(inner.default_status))
    }

    fn holds_from(&self, _settler: Address) -> Result<bool, ChainError> {
        Ok(self.0.borrow().holds)
    }
}

/// A signer that produces a deterministic transaction without a key.
#[derive(Debug, Clone, Copy, Default)]
pub struct FakeSigner;

impl SettlementSigner for FakeSigner {
    fn sign_settle_window(
        &self,
        ids: &[OrderId],
        deadline: u64,
        nonce: u64,
        fees: GasParams,
    ) -> Result<SignedSettlement, ChainError> {
        let mut raw = Vec::new();
        raw.extend_from_slice(&nonce.to_be_bytes());
        raw.extend_from_slice(&deadline.to_be_bytes());
        raw.extend_from_slice(&fees.gas_limit.to_be_bytes());
        for id in ids {
            raw.extend_from_slice(id.as_slice());
        }
        Ok(SignedSettlement {
            tx_hash: alloy_primitives::keccak256(&raw),
            raw,
        })
    }

    fn address(&self) -> Address {
        Address::with_last_byte(0x5e)
    }
}
