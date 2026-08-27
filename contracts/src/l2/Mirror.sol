// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PoolState, Side} from "../types/Types.sol";

/// @title Mirror — pure pricing over a snapshot of pool state (WP-2, FL-1, CT-8).
/// @notice Phase 2b stub — owner implements. A library, not a contract: the
/// same quote and clearing-price maths the settler's simulator runs, so an
/// on-chain quote and an off-chain one cannot drift.
library Mirror {
    /// @notice Expected output for `sellAmount` on `side` against `state`.
    /// @dev Prices are B per A in Q96 regardless of `Side`; all price
    /// arithmetic via `mulDiv`; outputs round down (CT-2, CT-12).
    function quote(PoolState memory, uint256, Side) internal pure returns (uint256) {
        revert("not implemented: Phase 2b");
    }

    /// @notice The mirror's age in slots: `(timestamp - mirrorTimestamp) / 12`.
    /// @dev The L1 head is not visible on L2, and the Sync block's timestamp
    /// equals the pinned L1 slot time (CT-8).
    function ageSlots(uint64, uint64) internal pure returns (uint32) {
        revert("not implemented: Phase 2b");
    }
}
