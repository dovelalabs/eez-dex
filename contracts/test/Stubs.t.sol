// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {DexBridge} from "../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../src/bridge/DexBridgeL2.sol";
import {Credit} from "../src/interfaces/IDexBridge.sol";
import {SettlementRouter} from "../src/l1/SettlementRouter.sol";
import {WindowBook} from "../src/l2/WindowBook.sol";
import {Order, Side, WindowLeg} from "../src/types/Types.sol";

/// @notice Every later phase's entry point exists, compiles, and fails loudly
/// naming its owner. These assertions are what makes the stub tree a contract
/// rather than a placeholder: a phase that lands a partial implementation
/// breaks its own row here, and no other phase's.
///
/// `UniswapV3Adapter`'s row is gone because CT-3 is implemented; it is
/// exercised by `test/l1/UniswapV3Adapter.t.sol` instead.
contract StubsTest is Test {
    function test_phase2a_settlement_router_is_a_stub() public {
        SettlementRouter router = new SettlementRouter();
        vm.expectRevert(bytes("not implemented: Phase 2a"));
        router.settle(new WindowLeg[](0));
    }

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
