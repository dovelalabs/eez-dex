// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {DexBridge} from "../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../src/bridge/DexBridgeL2.sol";
import {Credit} from "../src/interfaces/IDexBridge.sol";

/// @notice Every later phase's entry point exists, compiles, and fails loudly
/// naming its owner. These assertions are what makes the stub tree a contract
/// rather than a placeholder: a phase that lands a partial implementation
/// breaks its own row here, and no other phase's.
///
/// WP-1 and WP-2 are implemented, so their rows are gone: `SettlementRouter`
/// and `UniswapV3Adapter` are exercised by `test/l1/`, `WindowBook` and
/// `Mirror` by `test/l2/`. WP-B is the last row standing.
contract StubsTest is Test {
    function test_phase2c_bridge_pair_is_a_stub() public {
        DexBridge bridge = new DexBridge();
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridge.release(address(0), 0, address(0));
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridge.deposit(address(0), 0, new Credit[](0));

        DexBridgeL2 bridgeL2 = new DexBridgeL2();
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridgeL2.l2TokenFor(address(0));
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridgeL2.credit(address(0), new Credit[](0));
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridgeL2.mint(address(0), address(0), 0);
        vm.expectRevert(bytes("not implemented: Phase 2c"));
        bridgeL2.burn(address(0), address(0), 0);
    }
}
