// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IDexBridge} from "../../src/interfaces/IDexBridge.sol";
import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {IWETH9} from "../../src/l1/interfaces/IWETH9.sol";
import {SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {MockERC20, MockFeeOnTransferERC20} from "../mocks/MockERC20.sol";
import {MockPool} from "../mocks/MockPool.sol";
import {L1Fixture} from "./L1Fixture.sol";
import {MockDexBridge, RevertingReceiver} from "./mocks/MockDexBridge.sol";

/// @notice TS-1 for the L1 leg in the **full** form: the bought asset crosses
/// back into L2 balances inside the settlement frame — through `DexBridge` for
/// an ERC-20 and through the protocol's native value path for ETH (CT-5).
///
/// Phase 2c owns the real bridge; this suite tests against the frozen
/// `IDexBridge` and a mock of it (README, "soft cross-phase contracts"). The
/// real `release` -> swap -> `deposit` round trip is validated in Phase 6.
abstract contract SettlementRouterFullSuite is L1Fixture {
    address internal constant ALICE = address(0xA11CE);

    MockDexBridge internal dexBridge;

    function _bridge() internal override returns (IDexBridge) {
        if (address(dexBridge) == address(0)) dexBridge = new MockDexBridge();
        return dexBridge;
    }

    // --- CT-5 · the ERC-20 buy side ----------------------------------------------

    function test_ct5_credits_the_erc20_buy_side_through_the_bridge() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, ""));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);

        uint256 amountOut = results[0].amountOut;
        assertGt(amountOut, 0, "the residual swapped");
        assertEq(MockERC20(tokenB).balanceOf(address(dexBridge)), amountOut, "the bridge holds the reserve");
        assertEq(MockERC20(tokenB).balanceOf(address(router)), 0, "the router keeps none of it");

        assertEq(dexBridge.depositCount(), 1, "one credit per leg");
        (address token, uint256 amount, address recipient) = dexBridge.deposits(0);
        assertEq(token, tokenB, "the bought asset");
        assertEq(amount, amountOut, "the whole output");
        // `WindowBook` books every fill on L2 from the same `WindowResult`, so
        // the frame credits it once and it distributes to L2 balances.
        assertEq(recipient, WINDOW_BOOK, "credited to the book");
    }

    function test_ct5_reverts_when_a_leg_carries_a_genesis_distribution() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn)));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        vm.expectRevert(SettlementRouter.UnexpectedDistribution.selector);
        router.settle{value: residualIn}(legs);
    }

    // --- CT-5 · the ETH legs, both directions ------------------------------------

    function test_ct5_eth_sell_side_arrives_as_value() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, ""));

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        router.settle{value: residualIn}(legs);

        assertEq(address(router).balance, 0, "the value was wrapped, not held");
        assertEq(weth.balanceOf(address(pool)), 1e30 + residualIn, "and sold into the pool");
    }

    function test_ct5_eth_buy_side_uses_the_native_value_path() public {
        uint256 residualIn = 1 ether;
        // The outbound leg: `DexBridge.release` ran earlier in this L1 frame.
        MockERC20(tokenB).mint(address(dexBridge), residualIn);
        dexBridge.release(tokenB, residualIn, address(router));

        WindowLeg[] memory legs = _legs(_leg(Side.SELL_B_FOR_A, residualIn, 100, ""));
        uint256 zoneBefore = ZONE_PROXY.balance;

        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        uint256 amountOut = results[0].amountOut;
        assertGt(amountOut, 0, "the residual swapped");
        assertEq(ZONE_PROXY.balance - zoneBefore, amountOut, "delivered as value to the zone proxy");
        assertEq(weth.balanceOf(address(router)), 0, "nothing left wrapped");
        assertEq(dexBridge.depositCount(), 0, "an ETH leg does not touch the bridge");
    }

    function test_ct5_reverts_when_the_native_delivery_is_rejected() public {
        RevertingReceiver rejecting = new RevertingReceiver();
        eez.setProxy(WINDOW_BOOK, ZONE_ROLLUP_ID, address(rejecting));

        uint256 residualIn = 1 ether;
        MockERC20(tokenB).mint(address(dexBridge), residualIn);
        dexBridge.release(tokenB, residualIn, address(router));
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_B_FOR_A, residualIn, 100, ""));
        bytes memory expectedRevert = abi.encodeWithSelector(
            SettlementRouter.DeliveryFailed.selector, address(rejecting), _quoteOut(Side.SELL_B_FOR_A, residualIn)
        );

        vm.prank(address(rejecting));
        vm.expectRevert(expectedRevert);
        router.settle(legs);
    }

    // --- CT-5 · the sell side comes from the frame, not from thin air ------------

    function test_ct5_reverts_when_the_sell_side_was_not_released() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_B_FOR_A, residualIn, 100, ""));

        // No `release` ran: the router holds nothing to sell and the leg dies
        // here, which is how a short bridge reserve is evicted for free (CT-5).
        vm.prank(ZONE_PROXY);
        vm.expectRevert();
        router.settle(legs);
    }

    function test_ts1_rejects_a_fee_on_transfer_sell_token() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20("Fee", "FEE", 18, 100);
        SettlementRouter altRouter = _altVenue(MockERC20(address(fot)));

        uint256 residualIn = 1 ether;
        fot.mint(address(altRouter), residualIn);
        WindowLeg memory leg = WindowLeg({
            windowId: 1,
            residualSide: Side.SELL_B_FOR_A,
            residualIn: residualIn,
            minPriceX96: 0,
            maxPriceX96: type(uint256).max,
            deadline: DEADLINE,
            distribution: ""
        });

        vm.prank(ZONE_PROXY);
        vm.expectRevert(abi.encodeWithSelector(SettlementRouter.UnsupportedToken.selector, address(fot)));
        altRouter.settle(_legs(leg));
    }

    // --- CT-6 · the empty settlement is profile-independent ----------------------

    function test_ct6_empty_settlement_touches_no_bridge() public {
        WindowLeg[] memory legs = _legs(_leg(Side.SELL_A_FOR_B, 0, 100, ""));

        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        assertEq(results[0].amountIn, 0, "nothing in");
        assertEq(dexBridge.depositCount(), 0, "and nothing crossed back");
    }

    // --- §1 · profile is configuration, never a fork -----------------------------

    /// @notice The same leg, executed by a full-form and a genesis-form router
    /// against the same pool state, produces the same numbers. Only delivery
    /// differs — CT-5 "must not alter genesis-form behaviour".
    function test_ct5_delivery_is_the_only_difference_from_the_genesis_form() public {
        uint256 residualIn = 1 ether;
        WindowLeg[] memory fullLegs = _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, ""));
        WindowLeg[] memory genesisLegs =
            _legs(_leg(Side.SELL_A_FOR_B, residualIn, 100, _soleDistribution(ALICE, residualIn)));
        uint256 snapshot = vm.snapshotState();

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory full = router.settle{value: residualIn}(fullLegs);

        vm.revertToState(snapshot);

        SettlementRouter genesis = new SettlementRouter(
            eez, ZONE_ROLLUP_ID, WINDOW_BOOK, adapter, tokenA, tokenB, IWETH9(address(weth)), IDexBridge(address(0))
        );
        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory genesisResults = genesis.settle{value: residualIn}(genesisLegs);

        assertEq(genesisResults[0].amountIn, full[0].amountIn, "same amount in");
        assertEq(genesisResults[0].amountOut, full[0].amountOut, "same amount out");
        assertEq(genesisResults[0].referencePriceX96, full[0].referencePriceX96, "same P0");
        assertEq(genesisResults[0].executionPriceX96, full[0].executionPriceX96, "same realised price");
        assertEq(genesisResults[0].post.sqrtPriceX96, full[0].post.sqrtPriceX96, "same post-trade state");

        // ... and the bought asset ends up in different places, as specified.
        assertEq(MockERC20(tokenB).balanceOf(ALICE), genesisResults[0].amountOut, "genesis pays on L1");
    }

    // --- helpers ------------------------------------------------------------------

    /// @dev What the swap would realise, simulated against the live pool and
    /// rolled back.
    function _quoteOut(Side side, uint256 residualIn) internal returns (uint256 amountOut) {
        uint256 snapshot = vm.snapshotState();
        MockERC20(side == Side.SELL_A_FOR_B ? tokenA : tokenB).mint(address(adapter), residualIn);
        amountOut = adapter.swap(side, residualIn, 0);
        vm.revertToState(snapshot);
    }

    /// @dev A second full-form venue with a different B asset.
    function _altVenue(MockERC20 altB) internal returns (SettlementRouter altRouter) {
        MockPool altPool = _deployPool(address(weth), address(altB), POOL_SQRT_PRICE, POOL_LIQUIDITY);
        UniswapV3Adapter altAdapter = new UniswapV3Adapter(address(altPool), address(weth));
        altRouter = new SettlementRouter(
            eez, ZONE_ROLLUP_ID, WINDOW_BOOK, altAdapter, address(weth), address(altB), IWETH9(address(weth)), dexBridge
        );
    }
}

/// @notice The pair's A asset is the pool's `token0`.
contract SettlementRouterFullTest is SettlementRouterFullSuite {
    function _aIsToken0() internal pure override returns (bool) {
        return true;
    }
}

/// @notice The pair's A asset is the pool's `token1`.
contract SettlementRouterFullInvertedTest is SettlementRouterFullSuite {
    function _aIsToken0() internal pure override returns (bool) {
        return false;
    }
}
