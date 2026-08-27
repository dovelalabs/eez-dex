// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Credit, IDexBridge} from "../interfaces/IDexBridge.sol";

/// @title [full] DexBridge — the L1 reserve behind every L2 balance (WP-B, CT-5).
/// @notice Phase 2c stub — owner implements. Started from the framework's
/// illustrative `periphery/Bridge.sol` and hardened here: the reserve
/// invariant `Σ locked == Σ L2 supply` per token, rate limits, pausability,
/// and multisig + timelock upgrade (RD-2 §12).
///
/// Every stub body only reverts, so solc asks for the strictest mutability and
/// each is marked `pure` — an override may narrow, never widen. The interface
/// carries the real mutability; the owning phase drops `pure` as it writes
/// each body.
contract DexBridge is IDexBridge {
    /// @inheritdoc IDexBridge
    function release(address, uint256, address) external pure {
        revert("not implemented: Phase 2c");
    }

    /// @inheritdoc IDexBridge
    function deposit(address, uint256, Credit[] calldata) external pure {
        revert("not implemented: Phase 2c");
    }
}
