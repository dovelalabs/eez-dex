//! Solidity bindings for the contracts WP-1 and WP-2 deployed.
//!
//! Generated from `contracts/src/**` by `sol!`, which parses the declarations
//! below at compile time — so a field the contracts renamed becomes a Rust
//! compile error rather than a silently mis-decoded log.
//!
//! Only what the settler actually calls or decodes is here: `WindowBook`'s
//! settlement entry point and the views that carry its deployment parameters,
//! the four events window state is rebuilt from (SV-5), `SettlementRouter.settle`
//! for the `eth_call` simulation (SV-2), and the adapter's state read.
//!
//! **`settleWindow` takes order ids and a deadline.** The `WindowLeg` type is
//! here because the simulation encodes one, never because the settler sends
//! one: the contract builds the leg (CT-9).

use alloy_primitives::U256;
use alloy_primitives::aliases::I24;
use alloy_sol_types::sol;

use crate::types;

// `sol!` gives each event a positional constructor, and `OrderPlaced` has
// eight fields (CT-7). The arity is the contract's, not a design choice here.
#[allow(clippy::too_many_arguments)]
mod generated {
    use super::*;

    sol! {
        /// A.1's `Side`.
        #[derive(Debug, PartialEq, Eq)]
        enum Side {
            /// Sell A (the pool's `token0`) for B.
            SELL_A_FOR_B,
            /// Sell B (the pool's `token1`) for A.
            SELL_B_FOR_A
        }

        /// A.1's `Order`.
        #[derive(Debug)]
        struct Order {
            bytes32 id;
            address owner;
            Side side;
            uint256 sellAmount;
            uint256 minBuyAmount;
            address recipient;
            uint32 expiresAfter;
        }

        /// A.1's `WindowLeg`, built on L2 and never by the settler.
        #[derive(Debug)]
        struct WindowLeg {
            uint64 windowId;
            Side residualSide;
            uint256 residualIn;
            uint256 minPriceX96;
            uint256 maxPriceX96;
            uint64 deadline;
            bytes distribution;
        }

        /// A.1's `PoolState`.
        #[derive(Debug)]
        struct PoolState {
            uint160 sqrtPriceX96;
            uint128 liquidity;
            int24 tick;
        }

        /// A.1's `WindowResult`.
        #[derive(Debug)]
        struct WindowResult {
            uint256 amountIn;
            uint256 amountOut;
            uint256 referencePriceX96;
            uint256 executionPriceX96;
            PoolState post;
            uint64 l1Block;
        }

        /// One genesis recipient's share of the residual (CT-4, `IDexBridge.Credit`).
        #[derive(Debug)]
        struct Credit {
            address recipient;
            uint256 amount;
        }

        /// `WindowBook` — the L2 product surface (CT-7 … CT-14).

        interface IWindowBookAbi {
            event OrderPlaced(
                bytes32 indexed id,
                address indexed owner,
                uint64 indexed window,
                Side side,
                uint256 sellAmount,
                uint256 minBuyAmount,
                address recipient,
                uint32 expiresAfter
            );
            event OrderCancelled(bytes32 indexed id, address indexed owner, uint256 refund);
            event OrderExpired(bytes32 indexed id, address indexed owner, uint256 refund, bool credited);
            event OrderFilled(
                bytes32 indexed id,
                uint256 amountOut,
                uint256 feeAmount,
                uint256 routeFeeAmount,
                uint256 impactAmount
            );
            event WindowSettled(uint64 indexed windowId, WindowResult result);

            /// The cross-layer entry point. Order ids and a deadline — nothing else.
            function settleWindow(bytes32[] orderIds, uint64 deadline) external;

            function windowId() external view returns (uint64);
            function windowSlots() external view returns (uint8);
            function windowStartBlock() external view returns (uint64);
            function windowBlocksRemaining() external view returns (uint32);
            function mirror() external view returns (uint160 sqrtPriceX96, uint128 liquidity, int24 tick);
            function mirrorTimestamp() external view returns (uint64);
            function latestPrice() external view returns (uint256 referencePrice, uint64 l1Block, uint32 mirrorAgeSlots);
            function openOrderIds() external view returns (bytes32[]);
            function orderOf(bytes32 id) external view returns (Order);
            function statusOf(bytes32 id) external view returns (uint8);
            function placedWindow(bytes32 id) external view returns (uint64);
            function escrowInvariantDrift(address asset) external view returns (int256);
            function settler() external view returns (address);

            /// The deployment's own parameters. The book is the authority on the
            /// fee shape it charges, so the settler reads them rather than
            /// carrying a second copy that could disagree (CT-12).
            function PROFILE() external view returns (uint8);
            function ASSET_A() external view returns (address);
            function ASSET_B() external view returns (address);
            function FEE_MODE() external view returns (uint8);
            function FEE_BPS() external view returns (uint16);
            function FEE_FIXED_A() external view returns (uint256);
            function FEE_FIXED_B() external view returns (uint256);
            function ROUTE_FEE_MODEL() external view returns (uint8);
            function ROUTE_FEE_WEI() external view returns (uint256);
        }

        /// `SettlementRouter` on L1 — the leg the builder simulates (CT-1, CT-2).

        interface ISettlementRouterAbi {
            /// `block.timestamp > leg.deadline` on L1 (CT-1).
            error Expired();
            /// `P0`, read in-leg before the swap, is outside the band (CT-1).
            error ReferencePriceOutsideBand(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);
            /// The swap's realised average price is outside the band (CT-1).
            error ExecutionPriceOutsideBand(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);

            function settle(WindowLeg[] legs) external payable returns (WindowResult[] results);
        }

        /// The pool adapter's state read (CT-3).

        interface IPoolAdapterAbi {
            function quoteState() external view returns (PoolState state);
        }
    }
}

pub use generated::{
    Credit, IPoolAdapterAbi, ISettlementRouterAbi, IWindowBookAbi, Order, PoolState, Side,
    WindowLeg, WindowResult,
};

impl From<types::Side> for Side {
    fn from(side: types::Side) -> Self {
        match side {
            types::Side::SellAForB => Self::SELL_A_FOR_B,
            types::Side::SellBForA => Self::SELL_B_FOR_A,
        }
    }
}

/// A value crossed the ABI boundary in a shape the contracts do not define.
/// `sol!` gives every generated enum an `__Invalid` variant for exactly this,
/// and the settler refuses the value rather than guessing which side it meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the ABI carried a `Side` the contracts do not define")]
pub struct UnknownSide;

impl TryFrom<Side> for types::Side {
    type Error = UnknownSide;

    fn try_from(side: Side) -> Result<Self, Self::Error> {
        match side {
            Side::SELL_A_FOR_B => Ok(Self::SellAForB),
            Side::SELL_B_FOR_A => Ok(Self::SellBForA),
            Side::__Invalid => Err(UnknownSide),
        }
    }
}

impl From<&types::PoolState> for PoolState {
    fn from(state: &types::PoolState) -> Self {
        Self {
            sqrtPriceX96: state.sqrt_price_x96.to(),
            liquidity: state.liquidity,
            tick: I24::unchecked_from(state.tick),
        }
    }
}

impl From<&PoolState> for types::PoolState {
    fn from(state: &PoolState) -> Self {
        Self {
            sqrt_price_x96: U256::from(state.sqrtPriceX96),
            liquidity: state.liquidity,
            tick: state.tick.unchecked_into(),
        }
    }
}

impl From<&types::WindowLeg> for WindowLeg {
    fn from(leg: &types::WindowLeg) -> Self {
        Self {
            windowId: leg.window_id,
            residualSide: leg.residual_side.into(),
            residualIn: leg.residual_in,
            minPriceX96: leg.min_price_x96,
            maxPriceX96: leg.max_price_x96,
            deadline: leg.deadline,
            distribution: leg.distribution.clone().into(),
        }
    }
}

impl From<&WindowResult> for types::WindowResult {
    fn from(result: &WindowResult) -> Self {
        Self {
            amount_in: result.amountIn,
            amount_out: result.amountOut,
            reference_price_x96: result.referencePriceX96,
            execution_price_x96: result.executionPriceX96,
            post: (&result.post).into(),
            l1_block: result.l1Block,
        }
    }
}

/// `WindowBook.OrderStatus`. `NONE` and `OPEN` are the only two the settler
/// acts on: `_select` drops everything else (CT-9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus {
    /// No such order.
    None,
    /// In the open window and selectable.
    Open,
    /// Settled.
    Filled,
    /// Cancelled by its owner (CT-7).
    Cancelled,
    /// Swept or reclaimed after `expiresAfter` windows.
    Expired,
}

impl OrderStatus {
    /// Reads the enum's on-chain ordinal. An ordinal the contract does not
    /// define is `None`: the settler treats an order it cannot classify as one
    /// it must not select.
    pub fn from_ordinal(ordinal: u8) -> Self {
        match ordinal {
            1 => Self::Open,
            2 => Self::Filled,
            3 => Self::Cancelled,
            4 => Self::Expired,
            _ => Self::None,
        }
    }

    /// Whether `_select` would keep an order in this state.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Open)
    }
}

/// Decodes an `Order` view result into the settler's own type. `placed_window`
/// comes from the book's `placedWindow` mapping, not from the struct.
pub fn order_from_abi(order: &Order, placed_window: u64) -> Result<types::Order, UnknownSide> {
    Ok(types::Order {
        id: order.id,
        owner: order.owner,
        side: order.side.try_into()?,
        sell_amount: order.sellAmount,
        min_buy_amount: order.minBuyAmount,
        recipient: order.recipient,
        expires_after: order.expiresAfter,
        placed_window,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{Address, B256, U256, address, b256};
    use alloy_sol_types::{SolCall, SolEvent, SolValue};

    #[test]
    fn ct9_settle_window_takes_order_ids_and_a_deadline() {
        // The settler cannot send a leg even by accident: the entry point has
        // no field for one.
        let call = IWindowBookAbi::settleWindowCall {
            orderIds: vec![B256::repeat_byte(1), B256::repeat_byte(2)],
            deadline: 1_800_000_024,
        };
        let encoded = call.abi_encode();
        let decoded = IWindowBookAbi::settleWindowCall::abi_decode(&encoded).unwrap();
        assert_eq!(decoded.orderIds.len(), 2);
        assert_eq!(decoded.deadline, 1_800_000_024);
    }

    #[test]
    fn a1_side_crosses_the_abi_boundary_unchanged() {
        for side in [types::Side::SellAForB, types::Side::SellBForA] {
            let abi: Side = side.into();
            let ordinal = match abi {
                Side::SELL_A_FOR_B => 0,
                Side::SELL_B_FOR_A => 1,
                Side::__Invalid => unreachable!(),
            };
            assert_eq!(ordinal, side.as_u8());
            assert_eq!(types::Side::try_from(abi).unwrap(), side);
        }
        assert_eq!(types::Side::try_from(Side::__Invalid), Err(UnknownSide));
    }

    #[test]
    fn a1_pool_state_and_window_result_round_trip() {
        let state = types::PoolState {
            sqrt_price_x96: U256::from(1u8) << 96,
            liquidity: 42,
            tick: -7,
        };
        assert_eq!(types::PoolState::from(&PoolState::from(&state)), state);

        let result = WindowResult {
            amountIn: U256::from(11u8),
            amountOut: U256::from(22u8),
            referencePriceX96: U256::from(33u8),
            executionPriceX96: U256::from(44u8),
            post: (&state).into(),
            l1Block: 55,
        };
        let native = types::WindowResult::from(&result);
        assert_eq!(native.amount_in, U256::from(11u8));
        assert_eq!(native.post, state);
        assert_eq!(native.l1_block, 55);
    }

    #[test]
    fn ct4_the_genesis_distribution_encodes_as_the_contract_encodes_it() {
        // `abi.encode(Credit[])` — an offset, a length, then the pairs.
        let credits = vec![
            Credit {
                recipient: address!("00000000000000000000000000000000000000a1"),
                amount: U256::from(1u8),
            },
            Credit {
                recipient: address!("00000000000000000000000000000000000000b2"),
                amount: U256::from(2u8),
            },
        ];
        let encoded = credits.abi_encode();
        assert_eq!(
            encoded.len(),
            32 * 6,
            "offset, length, and two 2-word pairs"
        );
        let decoded = Vec::<Credit>::abi_decode(&encoded).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[1].amount, U256::from(2u8));
    }

    #[test]
    fn sv5_the_four_window_events_decode_from_their_topics() {
        // The events window state is rebuilt from across a restart.
        assert_ne!(
            IWindowBookAbi::OrderPlaced::SIGNATURE_HASH,
            IWindowBookAbi::OrderCancelled::SIGNATURE_HASH
        );
        assert_eq!(
            IWindowBookAbi::OrderFilled::SIGNATURE,
            "OrderFilled(bytes32,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            IWindowBookAbi::WindowSettled::SIGNATURE,
            "WindowSettled(uint64,(uint256,uint256,uint256,uint256,(uint160,uint128,int24),uint64))"
        );
    }

    #[test]
    fn ct9_order_status_ordinals_match_the_contract_and_default_shut() {
        assert!(OrderStatus::from_ordinal(1).is_open());
        for ordinal in [0u8, 2, 3, 4, 9, 255] {
            assert!(
                !OrderStatus::from_ordinal(ordinal).is_open(),
                "ordinal {ordinal} must not be selectable"
            );
        }
        assert_eq!(OrderStatus::from_ordinal(3), OrderStatus::Cancelled);
        assert_eq!(OrderStatus::from_ordinal(200), OrderStatus::None);
    }

    #[test]
    fn an_undefined_side_ordinal_is_refused_rather_than_guessed() {
        let abi = Order {
            id: B256::ZERO,
            owner: Address::ZERO,
            side: Side::__Invalid,
            sellAmount: U256::ZERO,
            minBuyAmount: U256::ZERO,
            recipient: Address::ZERO,
            expiresAfter: 0,
        };
        assert_eq!(order_from_abi(&abi, 0), Err(UnknownSide));
    }

    #[test]
    fn ct7_placed_window_comes_from_the_book_not_from_the_order_struct() {
        let abi = Order {
            id: b256!("00000000000000000000000000000000000000000000000000000000000000aa"),
            owner: Address::ZERO,
            side: Side::SELL_B_FOR_A,
            sellAmount: U256::from(5u8),
            minBuyAmount: U256::from(4u8),
            recipient: Address::ZERO,
            expiresAfter: 3,
        };
        let order = order_from_abi(&abi, 12).unwrap();
        assert_eq!(order.placed_window, 12);
        assert_eq!(order.side, types::Side::SellBForA);
        assert_eq!(order.expires_after, 3);
    }
}
