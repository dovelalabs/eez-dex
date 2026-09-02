// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Test.sol";

import {IWindowBook} from "../../src/interfaces/IWindowBook.sol";
import {OrderStatus, Profile} from "../../src/l2/WindowBook.sol";
import {Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {FrameFixture} from "./FrameFixture.sol";

/// @notice **[genesis]** The same frame with the bridge configured away —
/// RD-2 §1, CT-4, §10's "both profiles' leg shapes".
/// @dev Profile is configuration, never a fork: this suite deploys the same
/// `WindowBook` and the same `SettlementRouter` bytecode as the full-form
/// suite beside it, with `bridgeL2` and `bridge` set to the zero address. The
/// sell side is zone ether carried as the call's `value`; the bought asset is
/// distributed to L1 addresses inside the leg; there is no opposing flow, so
/// the whole window is the residual and FL-4 is vacuous.
contract GenesisFrameTest is FrameFixture {
    function setUp() public {
        _deployFrame(Profile.GENESIS);
    }

    /// @dev The configuration *is* the profile — there is no genesis code path
    /// to take, only a zero address that makes the full-form one unreachable.
    function test_scope_the_profile_is_configuration_not_a_fork() public view {
        assertEq(address(router.bridge()), address(0), "[genesis] carries no bridge");
        assertEq(address(book.BRIDGE_L2()), address(0), "[genesis] carries no L2 bridge");
        assertEq(uint8(book.PROFILE()), uint8(Profile.GENESIS));
        assertEq(book.ASSET_A(), address(0), "[genesis] every order sells zone ether (FL-3)");
    }

    /// @dev CT-4 end to end: two orders, one leg, both recipients paid on L1
    /// at the realised average price, rounded down, inside the same call.
    function test_ct4_the_leg_distributes_the_bought_asset_on_l1() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 1e18, 1_900e6);
        bytes32 b = _place(bob, Side.SELL_A_FOR_B, 2e18, 3_800e6);

        uint256 netA = 1e18 - _feeBps(1e18);
        uint256 netB = 2e18 - _feeBps(2e18);

        vm.recordLogs();
        _settle(_ids(a, b));
        WindowResult memory result = _lastSettlement();

        assertEq(result.amountIn, netA + netB, "FL-4 is vacuous: the whole window is the residual");
        assertEq(
            IERC20(l1AssetB).balanceOf(alice),
            Math.mulDiv(netA, result.amountOut, result.amountIn),
            "CT-4: paid on L1 at the realised average price, rounded down"
        );
        assertEq(
            IERC20(l1AssetB).balanceOf(bob), Math.mulDiv(netB, result.amountOut, result.amountIn), "CT-4: as above"
        );
        assertLe(
            IERC20(l1AssetB).balanceOf(alice) + IERC20(l1AssetB).balanceOf(bob),
            result.amountOut,
            "CT-12: the sum of outputs never exceeds the leg's output; the dust stays with the protocol"
        );

        // Nothing was credited on L2: delivery was the L1 distribution.
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.FILLED));
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.FILLED));
        assertEq(_balance(assetB, alice), 0, "[genesis] there is no L2 balance of the bought asset");
        assertGe(IERC20(l1AssetB).balanceOf(alice), 1_900e6, "CT-10: at or above the limit");
        assertGe(IERC20(l1AssetB).balanceOf(bob), 3_800e6, "CT-10: at or above the limit");
        _assertEscrowInvariant();
    }

    /// @dev The genesis escrow is zone ether and it leaves as the call's
    /// `value`: what the L1 leg wrapped equals what the book released (CT-13).
    function test_ct13_the_ether_escrow_leaves_as_the_calls_value() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        uint256 wrappedBefore = IERC20(l1AssetA).balanceOf(address(pool));

        vm.recordLogs();
        _settle(_ids(a));
        WindowResult memory result = _lastSettlement();

        assertEq(
            IERC20(l1AssetA).balanceOf(address(pool)) - wrappedBefore,
            result.amountIn,
            "the value the frame carried was wrapped and swapped, to the wei"
        );
        assertEq(book.released(address(0)), result.amountIn, "CT-13: the ledger recorded the same amount");
        assertEq(book.escrowed(address(0)), 0, "the window's escrow is gone");
        _assertEscrowInvariant();
    }

    /// @dev CT-6: a quiet window refreshes the mirror for one cross-layer call
    /// and no swap — the same path in both profiles.
    function test_ct6_a_drifted_pool_can_be_refreshed_without_a_swap() public {
        uint256 poolBefore = IERC20(l1AssetB).balanceOf(address(pool));
        _driftL1(Math.mulDiv(2_100e6, Q96, 1e18));

        // Nothing selectable: the book will not build a leg, so the refresh is
        // the settler's empty leg through the router, not `settleWindow`.
        vm.prank(address(managerL1));
        managerL1.createCrossChainProxy(address(book), ZONE_ROLLUP_ID);
        vm.prank(managerL1.computeCrossChainProxyAddress(address(book), ZONE_ROLLUP_ID));
        WindowResult[] memory results = router.settle(_emptyLeg());

        assertEq(results[0].amountIn, 0, "CT-6: no swap");
        assertEq(results[0].amountOut, 0, "CT-6: no swap");
        assertEq(results[0].referencePriceX96, _spotPriceX96(), "CT-6: current state, read and returned");
        assertEq(results[0].executionPriceX96, results[0].referencePriceX96, "CT-6: no impact to bear");
        assertEq(IERC20(l1AssetB).balanceOf(address(pool)), poolBefore, "the pool was only read");
    }

    // ------------------------------------------------------------------ helpers ---

    function _emptyLeg() private view returns (WindowLeg[] memory legs) {
        legs = new WindowLeg[](1);
        legs[0] = WindowLeg({
            windowId: 0,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: 0,
            minPriceX96: 0,
            maxPriceX96: type(uint256).max,
            deadline: uint64(block.timestamp) + DEADLINE_SECONDS,
            distribution: ""
        });
    }

    function _lastSettlement() private returns (WindowResult memory) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i != 0; --i) {
            if (logs[i - 1].topics[0] == IWindowBook.WindowSettled.selector) {
                return abi.decode(logs[i - 1].data, (WindowResult));
            }
        }
        revert("no WindowSettled in the logs");
    }
}
