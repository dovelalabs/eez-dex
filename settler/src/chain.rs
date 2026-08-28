//! What the settler reads and writes on the two chains.
//!
//! Every chain access is behind a trait, for two reasons. The first is SV-1's:
//! the task framework is written product-agnostic, and a task that named a
//! concrete RPC client could not be lifted out. The second is that TS-3's
//! suites drive the whole service — selection, submission, reconciliation —
//! without a chain behind it, which is only possible if the seam is a trait.
//!
//! The implementations are blocking wrappers over alloy's async provider. The
//! task loop is synchronous by design: a settler that must do exactly one
//! thing per window is easier to reason about, and to prove, as a state
//! machine stepped once per tick than as a set of racing futures.

use std::sync::Arc;

use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy_eips::eip2718::Encodable2718;
use alloy_network::TxSignerSync;
use alloy_primitives::{Address, B256, Bytes, TxKind, U256};
use alloy_provider::{Provider, RootProvider};
use alloy_rpc_types_eth::{BlockNumberOrTag, Filter, TransactionRequest};
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{SolCall, SolEvent};
use tokio::runtime::Runtime;

use crate::abi::{self, IWindowBookAbi, OrderStatus};
use crate::selection::{LegSimulator, SimulationError};
use crate::types::{Order, OrderId, PoolState, WindowLeg, WindowResult};
use crate::window::{BookFee, BookParams, BookProfile, BookRouteFee};

/// Why a chain access did not answer.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ChainError {
    /// The endpoint did not answer, or answered with an error.
    #[error("rpc: {0}")]
    Rpc(String),
    /// The endpoint answered with something the ABI does not describe.
    #[error("decode: {0}")]
    Decode(String),
    /// The configuration named something the chain does not have.
    #[error("configuration: {0}")]
    Configuration(String),
}

/// A block, as the settler cares about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HeadInfo {
    /// The block number.
    pub number: u64,
    /// Its timestamp, in unix seconds.
    pub timestamp: u64,
}

/// The window, as the book holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainWindow {
    /// The open window's id.
    pub id: u64,
    /// `WINDOW_SLOTS` in force for it (EC-6).
    pub slots: u8,
    /// The L2 block it opened at.
    pub start_block: u64,
    /// The mirror snapshot (FL-1).
    pub mirror: PoolState,
    /// The L2 timestamp the mirror was stamped at (CT-8).
    pub mirror_timestamp: u64,
    /// The last settlement's `P0` (CT-14).
    pub reference_price_x96: U256,
    /// The L1 block `P0` was read in.
    pub reference_l1_block: u64,
}

/// One `WindowBook` log the settler rebuilds state from (SV-5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookEvent {
    /// An order joined the open window (CT-7).
    Placed {
        /// The order as placed.
        order: Order,
        /// The L2 block it landed in.
        l2_block: u64,
        /// That block's timestamp.
        unix: u64,
    },
    /// An open order was cancelled and its escrow released (CT-7).
    Cancelled {
        /// The order cancelled.
        id: OrderId,
    },
    /// An expired order's escrow was released.
    Expired {
        /// The order swept or reclaimed.
        id: OrderId,
    },
    /// One order filled (CT-12).
    Filled {
        /// The order filled.
        id: OrderId,
        /// Its net output.
        amount_out: U256,
        /// The EC-1 protocol fee, in sell-asset units.
        fee_amount: U256,
        /// Its route-fee share.
        route_fee_amount: U256,
        /// Its impact share; zero if crossed.
        impact_amount: U256,
    },
    /// One window settled (CT-9). The L2 transaction that carried it is how
    /// the reconciler matches it to an L1 receipt (SV-4).
    Settled {
        /// The window that settled.
        window_id: u64,
        /// The leg's result, as the composer recorded it.
        result: WindowResult,
        /// The L2 transaction hash.
        tx_hash: B256,
        /// The L2 block it landed in.
        l2_block: u64,
        /// That block's timestamp.
        unix: u64,
    },
}

impl BookEvent {
    /// The L2 block the event landed in, where the event carries one.
    pub fn l2_block(&self) -> Option<u64> {
        match self {
            Self::Placed { l2_block, .. } | Self::Settled { l2_block, .. } => Some(*l2_block),
            _ => None,
        }
    }
}

/// What the L2->L1 front says about a transaction it was given (SV-5).
///
/// The front holds a cross-layer transaction until the Sync block, so "held"
/// and "dropped" are the two observables that matter. A pinned slot skipped
/// shows as `Dropped` once and is not poison; three in a row evict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontStatus {
    /// The front still holds it. Never resubmit from here (SV-3).
    Held,
    /// The front does not have it. One reading is not eviction.
    Dropped,
    /// It was included in an L2 block.
    Included {
        /// The L2 block.
        l2_block: u64,
    },
}

/// What the L1 leg cost, from the receipt (IX-2's `L1Receipt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct L1Receipt {
    /// The L1 transaction hash — the batch that carried the entry.
    pub tx_hash: B256,
    /// The L1 block it landed in.
    pub block_number: u64,
    /// Gas used.
    pub gas_used: u64,
    /// The effective gas price, in wei.
    pub effective_gas_price_wei: u128,
    /// `gas_used * effective_gas_price`, in wei.
    pub gas_cost_wei: u128,
    /// Whether the transaction succeeded.
    pub success: bool,
}

/// The L2 side: `WindowBook`, its logs, and the two heads SV-4 reads at.
pub trait L2Reader {
    /// The deployed book's own parameters (CT-12).
    fn book_params(&self) -> Result<BookParams, ChainError>;
    /// The open window and the mirror it will net at.
    fn window(&self) -> Result<ChainWindow, ChainError>;
    /// Every order the book would still select, ascending by id (CT-9).
    fn open_orders(&self) -> Result<Vec<Order>, ChainError>;
    /// `WindowBook` logs from `from_block` through the safe head (SV-5).
    fn events_since(&self, from_block: u64) -> Result<Vec<BookEvent>, ChainError>;
    /// The L2 safe head — one L1 confirmation, revocable. Operations read here.
    fn safe_head(&self) -> Result<HeadInfo, ChainError>;
    /// The L2 finalized head. Accounting reads here (SV-4).
    fn finalized_head(&self) -> Result<HeadInfo, ChainError>;
    /// CT-13's drift for one asset. Must be zero at every safe head.
    fn escrow_drift(&self, asset: Address) -> Result<i128, ChainError>;
    /// Whether an L2 block still carries the transaction that settled a window
    /// — how a rollback is observed: blocks un-happen and events go
    /// non-canonical (SV-4).
    fn is_canonical(&self, tx_hash: B256) -> Result<bool, ChainError>;
    /// The settler key's next L2 nonce.
    fn nonce(&self, settler: Address) -> Result<u64, ChainError>;
    /// The chain id and fees to sign with, at `gas_limit` — A.5's `L1_GAS`,
    /// which the settler sets rather than estimating in flight (SV-3).
    fn gas_params(&self, gas_limit: u64) -> Result<GasParams, ChainError>;
}

/// The L1 side: the head, the pool, the simulation, and the receipt.
pub trait L1Reader {
    /// The L1 head. Its timestamp is what CT-1's deadline is checked against.
    fn head(&self) -> Result<HeadInfo, ChainError>;
    /// The target pool's live state at that head (A.5, watcher).
    fn pool_state(&self) -> Result<PoolState, ChainError>;
    /// The receipt of the L1 transaction that carried a window's leg in
    /// `l1_block` — what the settlement actually cost (SV-4, IX-3).
    ///
    /// The leg runs inside the batch transaction's frame, so it has no hash of
    /// its own; what identifies it is its swap against the target pool in the
    /// L1 block the leg reported. A CT-6 refresh swaps nothing and therefore
    /// has no receipt to find, which is right: a refresh has no fills to
    /// divide gas over.
    fn entry_receipt(&self, l1_block: u64) -> Result<Option<L1Receipt>, ChainError>;
}

/// The L2->L1 front: where `settleWindow` must be sent (A.2, SV-3).
pub trait Front {
    /// Posts a signed transaction. Returns its hash.
    fn submit(&self, signed: &[u8]) -> Result<B256, ChainError>;
    /// What the front says about a transaction it was given.
    fn status(&self, tx_hash: B256) -> Result<FrontStatus, ChainError>;
}

/// Offline signing of the one settlement transaction per window (SV-3).
pub trait SettlementSigner {
    /// Signs `settleWindow(orderIds, deadline)` with **explicit gas** — the
    /// settler never estimates in flight.
    fn sign_settle_window(
        &self,
        ids: &[OrderId],
        deadline: u64,
        nonce: u64,
        fees: GasParams,
    ) -> Result<SignedSettlement, ChainError>;
    /// The address the settlements are signed by; `WindowBook.settler` must
    /// equal it or every settlement reverts `NotSettler`.
    fn address(&self) -> Address;
}

/// Explicit gas for the settlement transaction (A.5 `L1_GAS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GasParams {
    /// The L2 chain id.
    pub chain_id: u64,
    /// The L2 gas limit for `settleWindow`.
    pub gas_limit: u64,
    /// `maxFeePerGas`, in wei.
    pub max_fee_per_gas: u128,
    /// `maxPriorityFeePerGas`, in wei.
    pub max_priority_fee_per_gas: u128,
}

/// A settlement transaction, signed and ready to post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedSettlement {
    /// Its hash — how a restart recognises it (SV-5).
    pub tx_hash: B256,
    /// The EIP-2718 encoding to post to the front.
    pub raw: Vec<u8>,
}

// --- the RPC implementations -------------------------------------------------

/// A blocking JSON-RPC client over alloy's async provider.
#[derive(Debug, Clone)]
pub struct RpcClient {
    runtime: Arc<Runtime>,
    provider: RootProvider,
}

impl RpcClient {
    /// Connects to `url`, sharing `runtime` with every other client.
    pub fn connect(runtime: Arc<Runtime>, url: &str) -> Result<Self, ChainError> {
        let url = url
            .parse()
            .map_err(|e| ChainError::Configuration(format!("{url}: {e}")))?;
        let provider = RootProvider::new_http(url);
        Ok(Self { runtime, provider })
    }

    fn head_of(&self, tag: BlockNumberOrTag) -> Result<HeadInfo, ChainError> {
        let block = self
            .runtime
            .block_on(async { self.provider.get_block_by_number(tag).hashes().await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?
            .ok_or_else(|| ChainError::Rpc(format!("no {tag} block")))?;
        Ok(HeadInfo {
            number: block.header.number,
            timestamp: block.header.timestamp,
        })
    }

    fn call(&self, to: Address, data: Vec<u8>) -> Result<Bytes, ChainError> {
        let request = TransactionRequest::default()
            .to(to)
            .input(Bytes::from(data).into());
        self.runtime
            .block_on(async { self.provider.call(request).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))
    }
}

/// `WindowBook` over JSON-RPC.
#[derive(Debug, Clone)]
pub struct L2Rpc {
    client: RpcClient,
    book: Address,
}

impl L2Rpc {
    /// Reads `WindowBook` at `book` over `client`.
    pub fn new(client: RpcClient, book: Address) -> Self {
        Self { client, book }
    }

    fn call<C: SolCall>(&self, call: C) -> Result<C::Return, ChainError> {
        let data = call.abi_encode();
        let returned = self.client.call(self.book, data)?;
        C::abi_decode_returns(&returned).map_err(|e| ChainError::Decode(e.to_string()))
    }
}

impl L2Reader for L2Rpc {
    fn book_params(&self) -> Result<BookParams, ChainError> {
        let profile = match self.call(IWindowBookAbi::PROFILECall {})? {
            0 => BookProfile::Full,
            1 => BookProfile::Genesis,
            other => {
                return Err(ChainError::Decode(format!(
                    "unknown profile ordinal {other}"
                )));
            }
        };
        let fee = match self.call(IWindowBookAbi::FEE_MODECall {})? {
            0 => BookFee::Bps(self.call(IWindowBookAbi::FEE_BPSCall {})?),
            1 => BookFee::Fixed {
                a: self.call(IWindowBookAbi::FEE_FIXED_ACall {})?,
                b: self.call(IWindowBookAbi::FEE_FIXED_BCall {})?,
            },
            other => {
                return Err(ChainError::Decode(format!(
                    "unknown fee mode ordinal {other}"
                )));
            }
        };
        let route_fee = match self.call(IWindowBookAbi::ROUTE_FEE_MODELCall {})? {
            0 => BookRouteFee::Absorb,
            1 => BookRouteFee::Recover(self.call(IWindowBookAbi::ROUTE_FEE_WEICall {})?),
            other => {
                return Err(ChainError::Decode(format!(
                    "unknown route fee model ordinal {other}"
                )));
            }
        };
        Ok(BookParams {
            profile,
            asset_a: self.call(IWindowBookAbi::ASSET_ACall {})?,
            asset_b: self.call(IWindowBookAbi::ASSET_BCall {})?,
            fee,
            route_fee,
        })
    }

    fn window(&self) -> Result<ChainWindow, ChainError> {
        let mirror = self.call(IWindowBookAbi::mirrorCall {})?;
        let latest = self.call(IWindowBookAbi::latestPriceCall {})?;
        Ok(ChainWindow {
            id: self.call(IWindowBookAbi::windowIdCall {})?,
            slots: self.call(IWindowBookAbi::windowSlotsCall {})?,
            start_block: self.call(IWindowBookAbi::windowStartBlockCall {})?,
            mirror: PoolState {
                sqrt_price_x96: U256::from(mirror.sqrtPriceX96),
                liquidity: mirror.liquidity,
                tick: mirror.tick.unchecked_into(),
            },
            mirror_timestamp: self.call(IWindowBookAbi::mirrorTimestampCall {})?,
            reference_price_x96: latest.referencePrice,
            reference_l1_block: latest.l1Block,
        })
    }

    fn open_orders(&self) -> Result<Vec<Order>, ChainError> {
        let mut orders = Vec::new();
        for id in self.call(IWindowBookAbi::openOrderIdsCall {})? {
            let status = OrderStatus::from_ordinal(self.call(IWindowBookAbi::statusOfCall { id })?);
            if !status.is_open() {
                continue;
            }
            let order = self.call(IWindowBookAbi::orderOfCall { id })?;
            let placed = self.call(IWindowBookAbi::placedWindowCall { id })?;
            orders.push(
                abi::order_from_abi(&order, placed)
                    .map_err(|e| ChainError::Decode(e.to_string()))?,
            );
        }
        orders.sort_by_key(|order| order.id);
        Ok(orders)
    }

    fn events_since(&self, from_block: u64) -> Result<Vec<BookEvent>, ChainError> {
        let filter = Filter::new()
            .address(self.book)
            .from_block(from_block)
            .to_block(BlockNumberOrTag::Safe);
        let logs = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_logs(&filter).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;

        let mut events = Vec::with_capacity(logs.len());
        for log in &logs {
            let l2_block = log.block_number.unwrap_or_default();
            let unix = log.block_timestamp.unwrap_or_default();
            let tx_hash = log.transaction_hash.unwrap_or_default();
            let inner = &log.inner;

            if let Ok(placed) = IWindowBookAbi::OrderPlaced::decode_log(inner) {
                let order = Order {
                    id: placed.id,
                    owner: placed.owner,
                    side: placed
                        .side
                        .try_into()
                        .map_err(|e: abi::UnknownSide| ChainError::Decode(e.to_string()))?,
                    sell_amount: placed.sellAmount,
                    min_buy_amount: placed.minBuyAmount,
                    recipient: placed.recipient,
                    expires_after: placed.expiresAfter,
                    placed_window: placed.window,
                };
                events.push(BookEvent::Placed {
                    order,
                    l2_block,
                    unix,
                });
            } else if let Ok(cancelled) = IWindowBookAbi::OrderCancelled::decode_log(inner) {
                events.push(BookEvent::Cancelled { id: cancelled.id });
            } else if let Ok(expired) = IWindowBookAbi::OrderExpired::decode_log(inner) {
                events.push(BookEvent::Expired { id: expired.id });
            } else if let Ok(filled) = IWindowBookAbi::OrderFilled::decode_log(inner) {
                events.push(BookEvent::Filled {
                    id: filled.id,
                    amount_out: filled.amountOut,
                    fee_amount: filled.feeAmount,
                    route_fee_amount: filled.routeFeeAmount,
                    impact_amount: filled.impactAmount,
                });
            } else if let Ok(settled) = IWindowBookAbi::WindowSettled::decode_log(inner) {
                events.push(BookEvent::Settled {
                    window_id: settled.windowId,
                    result: (&settled.result).into(),
                    tx_hash,
                    l2_block,
                    unix,
                });
            }
        }
        Ok(events)
    }

    fn safe_head(&self) -> Result<HeadInfo, ChainError> {
        self.client.head_of(BlockNumberOrTag::Safe)
    }

    fn finalized_head(&self) -> Result<HeadInfo, ChainError> {
        self.client.head_of(BlockNumberOrTag::Finalized)
    }

    fn escrow_drift(&self, asset: Address) -> Result<i128, ChainError> {
        let drift = self.call(IWindowBookAbi::escrowInvariantDriftCall { asset })?;
        i128::try_from(drift)
            .map_err(|_| ChainError::Decode("escrow drift does not fit in i128".into()))
    }

    fn is_canonical(&self, tx_hash: B256) -> Result<bool, ChainError> {
        let receipt = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_transaction_receipt(tx_hash).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        Ok(receipt.is_some_and(|receipt| receipt.block_number.is_some()))
    }

    fn nonce(&self, settler: Address) -> Result<u64, ChainError> {
        self.client
            .runtime
            .block_on(async { self.client.provider.get_transaction_count(settler).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))
    }

    fn gas_params(&self, gas_limit: u64) -> Result<GasParams, ChainError> {
        let chain_id = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_chain_id().await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        // Explicit gas, read once and used whole: the settler never estimates
        // in flight, and a settlement that has to be signed at the boundary
        // cannot wait for a fee oracle (SV-3).
        let fees = self
            .client
            .runtime
            .block_on(async { self.client.provider.estimate_eip1559_fees().await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        Ok(GasParams {
            chain_id,
            gas_limit,
            max_fee_per_gas: fees.max_fee_per_gas,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
        })
    }
}

/// The L1 chain and the target pool over JSON-RPC.
#[derive(Debug, Clone)]
pub struct L1Rpc {
    client: RpcClient,
    router: Address,
    adapter: Address,
    pool: Address,
    zone_proxy: Address,
}

impl L1Rpc {
    /// Reads the pool through `adapter` and simulates `settle` on `router`.
    ///
    /// `zone_proxy` is the address the simulation is made *from*: `settle` is
    /// `onlyZone`, so an `eth_call` from anything else reverts `NotZone` and
    /// the settler would read every window as unsettleable (CT-1).
    pub fn new(
        client: RpcClient,
        router: Address,
        adapter: Address,
        pool: Address,
        zone_proxy: Address,
    ) -> Self {
        Self {
            client,
            router,
            adapter,
            pool,
            zone_proxy,
        }
    }

    /// The receipt for one L1 transaction.
    fn receipt(&self, tx_hash: B256) -> Result<Option<L1Receipt>, ChainError> {
        let receipt = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_transaction_receipt(tx_hash).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        Ok(receipt.map(|receipt| {
            let gas_used = receipt.gas_used;
            let price = receipt.effective_gas_price;
            L1Receipt {
                tx_hash,
                block_number: receipt.block_number.unwrap_or_default(),
                gas_used,
                effective_gas_price_wei: price,
                gas_cost_wei: u128::from(gas_used).saturating_mul(price),
                success: receipt.status(),
            }
        }))
    }
}

impl L1Reader for L1Rpc {
    fn head(&self) -> Result<HeadInfo, ChainError> {
        self.client.head_of(BlockNumberOrTag::Latest)
    }

    fn pool_state(&self) -> Result<PoolState, ChainError> {
        let data = abi::IPoolAdapterAbi::quoteStateCall {}.abi_encode();
        let returned = self.client.call(self.adapter, data)?;
        let state = abi::IPoolAdapterAbi::quoteStateCall::abi_decode_returns(&returned)
            .map_err(|e| ChainError::Decode(e.to_string()))?;
        Ok((&state).into())
    }

    fn entry_receipt(&self, l1_block: u64) -> Result<Option<L1Receipt>, ChainError> {
        // The leg's swap is the settlement's fingerprint in the L1 block: it
        // is the only thing in that block that touches the target pool on the
        // DEX's behalf.
        let filter = Filter::new()
            .address(self.pool)
            .from_block(l1_block)
            .to_block(l1_block);
        let logs = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_logs(&filter).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        let Some(tx_hash) = logs.first().and_then(|log| log.transaction_hash) else {
            return Ok(None);
        };
        self.receipt(tx_hash)
    }
}

impl LegSimulator for L1Rpc {
    /// SV-2's `eth_call` simulation of `SettlementRouter.settle` against the
    /// L1 head, made from the zone proxy so `onlyZone` passes.
    fn simulate(&self, leg: &WindowLeg) -> Result<WindowResult, SimulationError> {
        let call = abi::ISettlementRouterAbi::settleCall {
            legs: vec![leg.into()],
        };
        let request = TransactionRequest::default()
            .from(self.zone_proxy)
            .to(self.router)
            .input(Bytes::from(call.abi_encode()).into());

        let returned = self
            .client
            .runtime
            .block_on(async { self.client.provider.call(request).await })
            .map_err(|error| classify_revert(&error.to_string(), leg))?;

        let results = abi::ISettlementRouterAbi::settleCall::abi_decode_returns(&returned)
            .map_err(|e| SimulationError::Unavailable(e.to_string()))?;
        results
            .first()
            .map(Into::into)
            .ok_or_else(|| SimulationError::Unavailable("settle returned no legs".into()))
    }
}

/// Turns a revert from the simulated leg into the reason the selection loop
/// can act on.
///
/// The router's band errors are what FL-8 selects against, so they are matched
/// by name; anything else is `Unavailable`, which stops the settler rather
/// than making it drop orders to chase a revert it does not understand.
fn classify_revert(message: &str, leg: &WindowLeg) -> SimulationError {
    if message.contains("ReferencePriceOutsideBand") {
        return if message.contains("Below") {
            SimulationError::ReferenceBelowBand {
                price: U256::ZERO,
                min: leg.min_price_x96,
            }
        } else {
            // The router does not say which end; the band does. A reference
            // price the leg rejected is outside one of the two bounds, and the
            // selection loop only needs to know which to relieve.
            SimulationError::ReferenceAboveBand {
                price: U256::ZERO,
                max: leg.max_price_x96,
            }
        };
    }
    if message.contains("ExecutionPriceOutsideBand") {
        return SimulationError::ExecutionBelowBand {
            price: U256::ZERO,
            min: leg.min_price_x96,
        };
    }
    if message.contains("Expired") {
        return SimulationError::Expired;
    }
    SimulationError::Unavailable(message.to_string())
}

/// The L2->L1 front over JSON-RPC.
#[derive(Debug, Clone)]
pub struct FrontRpc {
    client: RpcClient,
}

impl FrontRpc {
    /// Posts to and reads from the front at `client`'s endpoint.
    pub fn new(client: RpcClient) -> Self {
        Self { client }
    }
}

impl Front for FrontRpc {
    fn submit(&self, signed: &[u8]) -> Result<B256, ChainError> {
        let pending = self
            .client
            .runtime
            .block_on(async { self.client.provider.send_raw_transaction(signed).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        Ok(*pending.tx_hash())
    }

    /// The front holds a cross-layer transaction until the Sync block, so the
    /// observable over plain JSON-RPC is whether it still knows the hash.
    ///
    /// One `Dropped` reading is **not** eviction: a pinned slot skipped looks
    /// exactly like this, and three consecutive readings are what evict (SV-5).
    /// That judgement is [`crate::attempt`]'s, not this method's.
    fn status(&self, tx_hash: B256) -> Result<FrontStatus, ChainError> {
        let transaction = self
            .client
            .runtime
            .block_on(async { self.client.provider.get_transaction_by_hash(tx_hash).await })
            .map_err(|e| ChainError::Rpc(e.to_string()))?;
        Ok(match transaction {
            None => FrontStatus::Dropped,
            Some(transaction) => match transaction.block_number {
                Some(l2_block) => FrontStatus::Included { l2_block },
                None => FrontStatus::Held,
            },
        })
    }
}

/// Offline signing with the settler key (SV-3).
#[derive(Debug, Clone)]
pub struct LocalSettlementSigner {
    signer: PrivateKeySigner,
    book: Address,
}

impl LocalSettlementSigner {
    /// Builds a signer for `SETTLER_KEY`, sending to `WindowBook` at `book`.
    ///
    /// The key never leaves this process and no transaction is ever signed by
    /// an endpoint: "signed offline" is SV-3's word for it.
    pub fn new(settler_key: &str, book: Address) -> Result<Self, ChainError> {
        let signer: PrivateKeySigner = settler_key
            .parse()
            .map_err(|e| ChainError::Configuration(format!("SETTLER_KEY: {e}")))?;
        Ok(Self { signer, book })
    }
}

impl SettlementSigner for LocalSettlementSigner {
    fn sign_settle_window(
        &self,
        ids: &[OrderId],
        deadline: u64,
        nonce: u64,
        fees: GasParams,
    ) -> Result<SignedSettlement, ChainError> {
        let call = IWindowBookAbi::settleWindowCall {
            orderIds: ids.to_vec(),
            deadline,
        };
        let mut tx = TxEip1559 {
            chain_id: fees.chain_id,
            nonce,
            gas_limit: fees.gas_limit,
            max_fee_per_gas: fees.max_fee_per_gas,
            max_priority_fee_per_gas: fees.max_priority_fee_per_gas,
            to: TxKind::Call(self.book),
            value: U256::ZERO,
            access_list: Default::default(),
            input: Bytes::from(call.abi_encode()),
        };
        let signature = self
            .signer
            .sign_transaction_sync(&mut tx)
            .map_err(|e| ChainError::Configuration(e.to_string()))?;
        let envelope: TxEnvelope = tx.into_signed(signature).into();
        Ok(SignedSettlement {
            tx_hash: *envelope.hash(),
            raw: envelope.encoded_2718(),
        })
    }

    fn address(&self) -> Address {
        self.signer.address()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_consensus::Transaction as _;
    use alloy_eips::eip2718::Decodable2718;
    use alloy_sol_types::SolCall;

    const KEY: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    fn gas() -> GasParams {
        GasParams {
            chain_id: 424_242,
            gas_limit: 1_000_000,
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
        }
    }

    #[test]
    fn sv3_the_settlement_is_signed_offline_with_explicit_gas() {
        let book = Address::with_last_byte(0xb0);
        let signer = LocalSettlementSigner::new(KEY, book).unwrap();
        let ids = vec![OrderId::with_last_byte(1), OrderId::with_last_byte(2)];

        let signed = signer
            .sign_settle_window(&ids, 1_800_000_024, 7, gas())
            .unwrap();

        // The envelope decodes back to exactly the call that was signed, with
        // the gas the settler chose — nothing was estimated in flight.
        let envelope = TxEnvelope::decode_2718(&mut signed.raw.as_slice()).unwrap();
        assert_eq!(*envelope.hash(), signed.tx_hash);
        assert_eq!(envelope.gas_limit(), 1_000_000);
        assert_eq!(envelope.nonce(), 7);
        assert_eq!(envelope.kind(), TxKind::Call(book));

        let call = IWindowBookAbi::settleWindowCall::abi_decode(envelope.input()).unwrap();
        assert_eq!(call.orderIds, ids, "order ids and a deadline, nothing else");
        assert_eq!(call.deadline, 1_800_000_024);
    }

    #[test]
    fn sv3_the_same_selection_signs_to_the_same_transaction() {
        // Determinism reaches the wire: two settlers with the same key, nonce
        // and selection produce byte-identical transactions (SV-2).
        let book = Address::with_last_byte(0xb0);
        let ids = vec![OrderId::with_last_byte(3)];
        let left = LocalSettlementSigner::new(KEY, book)
            .unwrap()
            .sign_settle_window(&ids, 1_800_000_024, 1, gas())
            .unwrap();
        let right = LocalSettlementSigner::new(KEY, book)
            .unwrap()
            .sign_settle_window(&ids, 1_800_000_024, 1, gas())
            .unwrap();
        assert_eq!(left, right);
    }

    #[test]
    fn a_bad_settler_key_is_refused_at_the_boundary() {
        assert!(matches!(
            LocalSettlementSigner::new("not-a-key", Address::ZERO),
            Err(ChainError::Configuration(_))
        ));
    }

    #[test]
    fn fl8_the_routers_band_reverts_become_reasons_to_drop_an_order() {
        let leg = WindowLeg {
            window_id: 0,
            residual_side: crate::types::Side::SellAForB,
            residual_in: U256::from(1u8),
            min_price_x96: U256::from(10u8),
            max_price_x96: U256::from(20u8),
            deadline: 1,
            distribution: Vec::new(),
        };
        assert!(matches!(
            classify_revert(
                "execution reverted: ExecutionPriceOutsideBand(1,10,20)",
                &leg
            ),
            SimulationError::ExecutionBelowBand { .. }
        ));
        assert!(matches!(
            classify_revert("execution reverted: Expired()", &leg),
            SimulationError::Expired
        ));
        // A revert the settler does not understand stops it rather than making
        // it drop orders to chase something it cannot attribute.
        assert!(matches!(
            classify_revert("execution reverted: NotZone(0x00)", &leg),
            SimulationError::Unavailable(_)
        ));
    }

    #[test]
    fn sv5_the_fronts_two_observables_are_held_and_dropped() {
        // The mapping itself, stated as a test so the meaning of a missing
        // transaction is written down: it is one drop, not an eviction.
        assert_ne!(FrontStatus::Held, FrontStatus::Dropped);
        assert_ne!(
            FrontStatus::Included { l2_block: 1 },
            FrontStatus::Included { l2_block: 2 }
        );
    }
}
