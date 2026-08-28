// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {DexBridge} from "../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../src/bridge/DexBridgeL2.sol";
import {Credit} from "../src/interfaces/IDexBridge.sol";
import {WindowBook} from "../src/l2/WindowBook.sol";
import {Order, Side} from "../src/types/Types.sol";

/// @notice Every later phase's entry point exists, compiles, and fails loudly
/// naming its owner. These assertions are what makes the stub tree a contract
/// rather than a placeholder: a phase that lands a partial implementation
/// breaks its own row here, and no other phase's.
///
/// Phase 2a's rows are gone because WP-1 is implemented: `SettlementRouter`
/// and `UniswapV3Adapter` are exercised by `test/l1/` instead.
contract StubsTest is Test {
    function test_phase2b_window_book_is_a_stub() public {
        WindowBook book = new WindowBook();
        Order memory order;

        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.place(order);
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.cancel(bytes32(0));
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.reclaim(bytes32(0));
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.withdraw(address(0), 0);
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.quote(1, Side.SELL_A_FOR_B);
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.latestPrice();
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.settleWindow(new bytes32[](0), 0);
        vm.expectRevert(bytes("not implemented: Phase 2b"));
        book.setSettler(address(this));
    }

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
