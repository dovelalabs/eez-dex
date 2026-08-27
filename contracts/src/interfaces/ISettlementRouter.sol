// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {WindowLeg, WindowResult} from "../types/Types.sol";

/// @title The L1 settlement entry point — RD-2 A.3, CT-1, CT-2.
/// @notice FROZEN AT THE SCAFFOLD. WP-1 implements it; WP-2 and WP-3 encode
/// calls against it.
interface ISettlementRouter {
    /// @notice `block.timestamp > leg.deadline`. A timestamp, not a block:
    /// the L1 head is not visible from L2 and the cross-chain format carries
    /// no block deadline (CT-1).
    error Expired();

    /// @notice Executes one window's residual per leg against the real pool.
    /// @dev Callable only via the zone proxy (`onlyZone`, A.3). Per leg: reads
    /// the pool's pre-trade spot as `P0`, reverts unless `P0` and the realised
    /// average price both lie inside `[leg.minPriceX96, leg.maxPriceX96]`,
    /// swaps the residual through the adapter, and distributes the output —
    /// on L1 per `leg.distribution` [genesis], or into `DexBridge.deposit`
    /// for an L2 credit [full]. A leg with `residualIn == 0` reads and returns
    /// state only (CT-6). The sell side arrives as `msg.value` for ETH legs.
    /// One leg at launch; the array is the multi-pair path within one bundle
    /// slot (EC-5).
    /// @return results One `WindowResult` per leg, in the same order. This is
    /// what the composer records; the rolling hash binds it.
    function settle(WindowLeg[] calldata legs) external payable returns (WindowResult[] memory results);
}
