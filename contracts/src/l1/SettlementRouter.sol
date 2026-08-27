// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ISettlementRouter} from "../interfaces/ISettlementRouter.sol";
import {WindowLeg, WindowResult} from "../types/Types.sol";

/// @title SettlementRouter — the L1 leg of one window (WP-1, CT-1 … CT-6).
/// @notice Phase 2a stub — owner implements. Only Phase 2a fills this in.
///
/// Every stub body only reverts, so solc asks for the strictest mutability and
/// each is marked `pure` — an override may narrow, never widen. The interface
/// carries the real mutability; the owning phase drops `pure` as it writes
/// each body.
contract SettlementRouter is ISettlementRouter {
    /// @inheritdoc ISettlementRouter
    function settle(WindowLeg[] calldata) external payable returns (WindowResult[] memory) {
        revert("not implemented: Phase 2a");
    }
}
