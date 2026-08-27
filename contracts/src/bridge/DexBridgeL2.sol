// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Credit} from "../interfaces/IDexBridge.sol";
import {IDexBridgeL2} from "../interfaces/IDexBridgeL2.sol";

/// @title [full] DexBridgeL2 — the L2 side of every ERC-20 movement (WP-B, CT-11).
/// @notice Phase 2c stub — owner implements.
///
/// Every stub body only reverts, so solc asks for the strictest mutability and
/// each is marked `pure` — an override may narrow, never widen. The interface
/// carries the real mutability; the owning phase drops `pure` as it writes
/// each body.
contract DexBridgeL2 is IDexBridgeL2 {
    /// @inheritdoc IDexBridgeL2
    function l2TokenFor(address) external pure returns (address) {
        revert("not implemented: Phase 2c");
    }

    /// @inheritdoc IDexBridgeL2
    function credit(address, Credit[] calldata) external pure {
        revert("not implemented: Phase 2c");
    }

    /// @inheritdoc IDexBridgeL2
    function mint(address, address, uint256) external pure {
        revert("not implemented: Phase 2c");
    }

    /// @inheritdoc IDexBridgeL2
    function burn(address, address, uint256) external pure {
        revert("not implemented: Phase 2c");
    }
}
