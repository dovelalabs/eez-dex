// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {stdStorage, StdStorage, Vm} from "forge-std/Test.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {IWindowBook} from "../../src/interfaces/IWindowBook.sol";
import {SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {OrderStatus, Profile, WindowBook} from "../../src/l2/WindowBook.sol";
import {PoolState, Side, WindowResult} from "../../src/types/Types.sol";
import {FrameFixture} from "./FrameFixture.sol";

/// @notice **[full]** The whole frame, once — RD-2 §10, CT-5, CT-9 … CT-13.
/// @dev Phase 6 part A, items 1 and 2: `WindowBook.settleWindow` against the
/// *real* `SettlementRouter` over a real pool, and the bridge round trip
/// `DexBridgeL2.releaseTo` → `DexBridge.release` → `settle` →
/// `DexBridge.deposit` → `DexBridgeL2.credit` → an L2 balance — in one atomic
/// composition, both directions of the pair.
contract FullFrameTest is FrameFixture {
    using stdStorage for StdStorage;

    function setUp() public {
        _deployFrame(Profile.FULL);
    }

    // -------------------------------------- A.2 · the frame, ether in, USDC out ---

    /// @dev The A-residual direction: the sell side is zone ether carried as
    /// the call's `value` and wrapped on L1; the buy side is USDC, which
    /// crosses back as a `DexBridge` deposit credited to an L2 balance (CT-11).
    function test_ct5_the_frame_sells_ether_on_l1_and_credits_usdc_on_l2() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 3e18, 5_900e6);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, 4_000e6, 1.9e18);

        uint256 lockedBefore = bridge.locked(l1AssetB);
        uint256 poolEthBefore = IERC20(l1AssetA).balanceOf(address(pool));

        _settle(_ids(a, b));

        // One swap happened, on the real pool, for the residual the book netted.
        uint256 netA = 3e18 - _feeBps(3e18);
        uint256 netB = 4_000e6 - _feeBps(4_000e6);
        uint256 crossedInA = Math.mulDiv(netB, Q96, _price());
        uint256 residualIn = netA - crossedInA;
        assertEq(
            IERC20(l1AssetA).balanceOf(address(pool)) - poolEthBefore, residualIn, "the pool took exactly the residual"
        );

        // The bought USDC is locked on L1 and minted on L2, one for one.
        uint256 bought = bridge.locked(l1AssetB) - lockedBefore;
        assertGt(bought, 0, "the residual bought something");
        _assertReserveInvariant();

        // Both orders are filled, inside their limits, from the two pots.
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.FILLED), "the residual-side order filled");
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.FILLED), "the crossed order filled");
        assertEq(book.balanceOf(assetB, alice), netB + bought, "the residual side takes the crossed pot and the leg");
        assertGe(book.balanceOf(assetB, alice), 5_900e6, "CT-10: filled at or above the limit");
        assertEq(book.balanceOf(address(0), bob), crossedInA, "the crossed side clears at the mirror price");
        assertGe(book.balanceOf(address(0), bob), 1.9e18, "CT-10: filled at or above the limit");

        _assertEscrowInvariant();
    }

    // -------------------------------------- A.2 · the frame, USDC in, ether out ---

    /// @dev The B-residual direction, and the only path in the product where
    /// an ERC-20 leaves L2: the burn on L2 and `DexBridge.release` to the
    /// router are one frame, the router swaps and unwraps, and the ether comes
    /// back as the call's `value` (CT-5, CT-11).
    function test_ct5_the_frame_releases_usdc_to_the_router_and_credits_ether_on_l2() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 1e18, 1_900e6);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, 6_000e6, 2.8e18);

        uint256 lockedBefore = bridge.locked(l1AssetB);
        uint256 poolUsdBefore = IERC20(l1AssetB).balanceOf(address(pool));

        _settle(_ids(a, b));

        uint256 netA = 1e18 - _feeBps(1e18);
        uint256 netB = 6_000e6 - _feeBps(6_000e6);
        uint256 crossedInB = Math.mulDiv(netA, _price(), Q96);
        uint256 residualIn = netB - crossedInB;

        assertEq(
            IERC20(l1AssetB).balanceOf(address(pool)) - poolUsdBefore, residualIn, "the pool took exactly the residual"
        );
        assertEq(lockedBefore - bridge.locked(l1AssetB), residualIn, "the reserve fell by the released residual");
        _assertReserveInvariant();

        uint256 bought = book.balanceOf(address(0), bob) - crossedInB;
        assertGt(bought, 0, "the residual bought ether, delivered as the call's value");
        assertGe(book.balanceOf(address(0), bob), 2.8e18, "CT-10: filled at or above the limit");
        assertEq(book.balanceOf(assetB, alice), crossedInB, "the crossed side clears at the mirror price");
        assertGe(book.balanceOf(assetB, alice), 1_900e6, "CT-10: filled at or above the limit");

        _assertEscrowInvariant();
    }

    // ------------------------------------- A.1 · the result the mock only asserted ---

    /// @dev What WP-2's suite asserted against a crafted `WindowResult` now
    /// comes from the router: `P0` is the pool's pre-trade spot, the mirror
    /// becomes the pool's post-trade state, and `latestPrice` reports both
    /// (CT-2, CT-14, FL-1).
    function test_ct14_the_settled_result_is_the_pools_own_state() public {
        uint256 spotBefore = _spotPriceX96();

        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 2e18, 0);
        vm.recordLogs();
        _settle(_ids(a));

        WindowResult memory result = _lastSettlement();
        assertEq(result.referencePriceX96, spotBefore, "CT-2: P0 is the pool's pre-trade spot, read in-leg");
        assertEq(result.post.sqrtPriceX96, pool.sqrtPriceX96(), "the mirror adopts the pool's post-trade state");
        assertEq(result.l1Block, uint64(block.number), "the L1 block the price was read in");

        (uint160 sqrtPriceX96,,) = book.mirror();
        assertEq(sqrtPriceX96, pool.sqrtPriceX96(), "FL-1: the mirror is the pool after the leg");

        (uint256 priceX96, uint64 l1Block, uint32 ageSlots) = book.latestPrice();
        assertEq(priceX96, spotBefore, "CT-14: latestPrice is the last settlement's P0");
        assertEq(l1Block, uint64(block.number));
        assertEq(ageSlots, 0, "CT-14: freshly settled, so zero slots old");

        // The residual side pays the impact and the venue's fee, so it is
        // filled below the reference price and above nothing else (FL-5).
        assertLt(result.executionPriceX96, result.referencePriceX96, "the residual bears its own impact");
        _assertEscrowInvariant();
    }

    /// @dev CT-1's band is the contract's, not the settler's: a drift that
    /// breaks the tightest limit reverts inside the L1 leg, which is what an
    /// eviction costs nothing for (FL-7). Nothing on L2 moved.
    function test_fl7_a_band_break_on_l1_reverts_the_whole_frame_for_free() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 2e18, 3_900e6);
        _driftL1(Math.mulDiv(1_800e6, Q96, 1e18));

        // Read before the prank: an argument that calls out would spend it.
        bytes memory expected = abi.encodeWithSelector(
            SettlementRouter.ReferencePriceOutsideBand.selector,
            _spotPriceX96(),
            Math.mulDiv(3_900e6, Q96, 2e18 - _feeBps(2e18), Math.Rounding.Ceil),
            type(uint256).max
        );
        uint64 deadline = uint64(block.timestamp) + DEADLINE_SECONDS;

        vm.prank(settler);
        vm.expectRevert(expected);
        book.settleWindow(_ids(a), deadline);

        assertEq(book.windowId(), 0, "the window did not advance");
        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "the order is still open");
        assertEq(book.escrowed(address(0)), 2e18, "escrow intact to the wei");
        _assertEscrowInvariant();
    }

    /// @dev A short reserve is the A.6 row: `release` reverts, so the frame
    /// reverts, so the window is evicted for free (CT-5). The invariant makes
    /// this unreachable by trading, so the reserve is written short directly —
    /// which is the operator error the row exists to prove is survivable.
    function test_ct5_a_short_bridge_reserve_reverts_the_frame() public {
        bytes32 a = _place(alice, Side.SELL_A_FOR_B, 1e18, 0);
        bytes32 b = _place(bob, Side.SELL_B_FOR_A, 6_000e6, 0);

        stdstore.target(address(bridge)).sig("locked(address)").with_key(l1AssetB).checked_write(uint256(0));

        vm.prank(settler);
        vm.expectRevert();
        book.settleWindow(_ids(a, b), uint64(block.timestamp) + DEADLINE_SECONDS);

        assertEq(uint8(book.statusOf(a)), uint8(OrderStatus.OPEN), "the order is still open");
        assertEq(uint8(book.statusOf(b)), uint8(OrderStatus.OPEN), "the order is still open");
        assertEq(book.escrowed(address(0)), 1e18, "escrow intact");
        assertEq(book.escrowed(assetB), 6_000e6, "escrow intact");
        assertEq(IERC20(assetB).totalSupply(), 6_000e6, "no L2 representation was burned");
    }

    // ------------------------------------------------------------------ helpers ---

    /// @dev The `WindowSettled` the settlement emitted, decoded from the logs.
    function _lastSettlement() private returns (WindowResult memory result) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i != 0; --i) {
            if (logs[i - 1].topics[0] == IWindowBook.WindowSettled.selector) {
                return abi.decode(logs[i - 1].data, (WindowResult));
            }
        }
        revert("no WindowSettled in the logs");
    }
}
