// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Credit, IDexBridge} from "../../../src/interfaces/IDexBridge.sol";

/// @notice A counterpart that abuses the inbound credit call: instead of
/// minting, it calls straight back into `DexBridge.deposit` while the first
/// deposit is still open. Stands in for any way the L2 half of the frame could
/// re-enter L1 — the property under test is that the reserve is credited
/// exactly once regardless.
contract ReentrantL2Bridge {
    IDexBridge public immutable BRIDGE;

    uint256 public creditCalls;

    constructor(IDexBridge bridge_) {
        BRIDGE = bridge_;
    }

    function credit(address l1Token, Credit[] calldata credits) external {
        creditCalls += 1;
        if (creditCalls > 1) return;
        BRIDGE.deposit(l1Token, credits[0].amount, credits);
    }
}
