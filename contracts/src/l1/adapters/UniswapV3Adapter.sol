// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPoolAdapter} from "../../interfaces/IPoolAdapter.sol";
import {PoolState, Side} from "../../types/Types.sol";

/// @title The first venue behind IPoolAdapter (WP-1, CT-3).
/// @notice Phase 2a stub — owner implements. A second venue is a new adapter
/// beside this one, never a change to SettlementRouter.
///
/// Every stub body only reverts, so solc asks for the strictest mutability and
/// each is marked `pure` — an override may narrow, never widen. The interface
/// carries the real mutability; the owning phase drops `pure` as it writes
/// each body.
contract UniswapV3Adapter is IPoolAdapter {
    /// @inheritdoc IPoolAdapter
    function quoteState() external pure returns (PoolState memory) {
        revert("not implemented: Phase 2a");
    }

    /// @inheritdoc IPoolAdapter
    function swap(Side, uint256, uint256) external pure returns (uint256) {
        revert("not implemented: Phase 2a");
    }
}
