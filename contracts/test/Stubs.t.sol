// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {DexBridge} from "../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../src/bridge/DexBridgeL2.sol";
import {Credit} from "../src/interfaces/IDexBridge.sol";
import {UniswapV3Adapter} from "../src/l1/adapters/UniswapV3Adapter.sol";
import {SettlementRouter} from "../src/l1/SettlementRouter.sol";
import {WindowBook} from "../src/l2/WindowBook.sol";
import {Order, Side, WindowLeg} from "../src/types/Types.sol";

/// @notice Every unwritten phase's entry point exists, compiles, and fails
/// loudly naming its owner; a phase that has landed asserts that it no longer
/// does. These assertions are what makes the stub tree a contract rather than a
/// placeholder: a phase that lands a partial implementation breaks its own row
/// here, and no other phase's.
contract StubsTest is Test {
    function test_phase2a_settlement_router_is_a_stub() public {
        SettlementRouter router = new SettlementRouter();
        vm.expectRevert(bytes("not implemented: Phase 2a"));
        router.settle(new WindowLeg[](0));
    }

    function test_phase2a_uniswap_adapter_is_a_stub() public {
        UniswapV3Adapter adapter = new UniswapV3Adapter();
        vm.expectRevert(bytes("not implemented: Phase 2a"));
        adapter.quoteState();
        vm.expectRevert(bytes("not implemented: Phase 2a"));
        adapter.swap(Side.SELL_A_FOR_B, 1, 0);
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

    /// @notice Phase 2c has landed, so the bridge pair's row asserts the
    /// opposite of the others: no entry point still names an unwritten phase.
    /// What the pair actually does is pinned by TS-B in `test/bridge/`.
    function test_phase2c_bridge_pair_is_implemented() public {
        DexBridge bridge = new DexBridge();
        _assertImplemented(address(bridge), abi.encodeCall(DexBridge.release, (address(0), 0, address(0))));
        _assertImplemented(address(bridge), abi.encodeCall(DexBridge.deposit, (address(0), 0, new Credit[](0))));

        DexBridgeL2 bridgeL2 = new DexBridgeL2();
        _assertImplemented(address(bridgeL2), abi.encodeCall(DexBridgeL2.l2TokenFor, (address(0))));
        _assertImplemented(address(bridgeL2), abi.encodeCall(DexBridgeL2.credit, (address(0), new Credit[](0))));
        _assertImplemented(address(bridgeL2), abi.encodeCall(DexBridgeL2.mint, (address(0), address(0), 0)));
        _assertImplemented(address(bridgeL2), abi.encodeCall(DexBridgeL2.burn, (address(0), address(0), 0)));
    }

    /// @dev The call may still revert — these are bare implementations with no
    /// counterpart wired — but never with the stub's message.
    function _assertImplemented(address target, bytes memory call) private {
        (bool ok, bytes memory returned) = target.call(call);
        if (ok) return;
        assertNotEq(
            keccak256(returned),
            keccak256(abi.encodeWithSignature("Error(string)", "not implemented: Phase 2c")),
            "Phase 2c entry point is still a stub"
        );
    }
}
