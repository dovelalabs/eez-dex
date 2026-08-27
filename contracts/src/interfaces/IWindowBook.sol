// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Order, Side, WindowResult} from "../types/Types.sol";

/// @title The L2 product surface — RD-2 A.2, CT-7 … CT-14.
/// @notice FROZEN AT THE SCAFFOLD. WP-2 implements it; WP-3 and WP-5 read its
/// events; WP-6 calls `place`, `cancel` and `quote`.
interface IWindowBook {
    /// @notice One window has settled. `result` is the L1 leg's return, as the
    /// composer recorded it; `post` inside it is the new mirror (FL-1, CT-9).
    event WindowSettled(uint64 indexed windowId, WindowResult result);

    /// @notice One order filled, with every deduction stated absolutely in
    /// sell-asset units so the indexer needs no inference (CT-12).
    event OrderFilled(
        bytes32 indexed id, uint256 amountOut, uint256 feeAmount, uint256 routeFeeAmount, uint256 impactAmount
    );

    // --- the user surface -----------------------------------------------------

    /// @notice Escrows `o.sellAmount` and appends the order to the open window.
    /// @dev The id is derived on-chain as `keccak256(owner, nonce)`, never
    /// user-supplied (CT-7). Escrow is an ERC-20 `transferFrom` [full] or
    /// `msg.value` [genesis]. An order placed in the Sync block after
    /// `settleWindow` belongs to the next window.
    function place(Order calldata o) external payable returns (bytes32 id);

    /// @notice Releases escrow for any open order, at any time.
    /// @dev A cancel that lands before `settleWindow` in the Sync block simply
    /// removes the order from the selection and can never revert a settlement
    /// (CT-7, CT-9).
    function cancel(bytes32 id) external;

    /// @notice Releases escrow for an expired order. Anyone may call it.
    function reclaim(bytes32 id) external;

    /// @notice [full] Moves an L2 balance out of the book.
    function withdraw(address asset, uint256 amount) external;

    // --- views ----------------------------------------------------------------

    /// @notice Indicative quote against the mirror (FL-2, CT-8).
    /// @return amountOut Expected output for `sellAmount` on `side`.
    /// @return mirrorAgeSlots `(block.timestamp - mirrorTimestamp) / 12` — the
    /// L1 head is not visible on L2, and the Sync block's timestamp equals the
    /// pinned L1 slot time.
    /// @return blocksRemaining L2 blocks left in the current window.
    function quote(
        uint256 sellAmount,
        Side side
    )
        external
        view
        returns (uint256 amountOut, uint32 mirrorAgeSlots, uint32 blocksRemaining);

    /// @notice The mirror exposed as a price for other L2 contracts (CT-14).
    /// @dev Its trust is this contract's storage plus the `SYSTEM_ADDRESS`-only
    /// `loadExecutionTable` path: L1 return data is not verifiable from L2. It
    /// is a spot read of one pool and is movable for one L1 block.
    function latestPrice() external view returns (uint256 referencePriceX96, uint64 l1Block, uint32 mirrorAgeSlots);

    // --- settlement -----------------------------------------------------------

    /// @notice The cross-layer entry point. Settler-only, and it MUST be sent
    /// to the L2->L1 front.
    /// @dev The contract, not the settler, builds the leg (CT-9): it drops any
    /// id no longer open or expired, computes cross and residual over the
    /// remainder, derives the price band, and reverts before any L1 call if
    /// the band is empty or nothing remains. After the call it fills crossed
    /// orders at `referencePriceX96` and residual-side orders at that price
    /// less their pro-rata impact, enforces CT-10, releases escrow, books fees,
    /// adopts `post` as the mirror, advances `windowId` and sweeps expiries.
    /// The settler's `orderIds` is a suggestion, never an instruction (FL-8).
    function settleWindow(bytes32[] calldata orderIds, uint64 deadline) external;

    /// @notice Rotates the settler key. Owner-only (§3).
    function setSettler(address settler) external;
}
