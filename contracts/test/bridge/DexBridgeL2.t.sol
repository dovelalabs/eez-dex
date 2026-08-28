// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../../src/bridge/DexBridgeL2.sol";
import {DexBridgeToken} from "../../src/bridge/DexBridgeToken.sol";
import {Credit} from "../../src/interfaces/IDexBridge.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {BridgeFixture} from "./BridgeFixture.sol";

/// @title TS-B — the `DexBridgeL2` suite (WP-B, CT-11, EC-4).
/// @notice The L2 half of the reserve invariant: supply is created only by a
/// credit that arrived through `DexBridge`'s proxy, and destroyed only by a
/// burn that fires the matching L1 release in the same frame.
contract DexBridgeL2Test is BridgeFixture {
    MockERC20 internal weth;
    DexBridgeToken internal l2Weth;

    address internal user = makeAddr("user");
    address internal router = makeAddr("router");

    function setUp() public {
        _deployBridgePair();

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        l2Weth = DexBridgeToken(_registerToken(address(weth), "eez Wrapped Ether", "eezWETH", 18, NO_RATE_LIMIT));

        weth.mint(address(this), 100 ether);
        _depositTo(address(weth), user, 100 ether);
    }

    // --- minting is proxy-authorised only (CT-11) ------------------------------

    function test_tsb_credit_only_from_the_bridge_proxy(address caller) public {
        vm.assume(caller != bridgeL2.l1BridgeProxy());

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: caller, amount: 1 ether});

        vm.prank(caller);
        vm.expectRevert(DexBridgeL2.UnauthorizedCaller.selector);
        bridgeL2.credit(address(weth), credits);
    }

    function test_tsb_mint_only_from_the_bridge_proxy(address caller, uint256 amount) public {
        vm.assume(caller != bridgeL2.l1BridgeProxy());

        vm.prank(caller);
        vm.expectRevert(DexBridgeL2.UnauthorizedCaller.selector);
        bridgeL2.mint(address(weth), caller, amount);
    }

    /// @notice Only `DexBridgeL2` may mint or burn the representation itself,
    /// so there is no supply the L1 reserve does not back.
    function test_tsb_l2_representation_mints_only_for_its_bridge(address caller) public {
        vm.assume(caller != address(bridgeL2));

        vm.startPrank(caller);
        vm.expectRevert(DexBridgeToken.OnlyBridge.selector);
        l2Weth.mint(caller, 1 ether);
        vm.expectRevert(DexBridgeToken.OnlyBridge.selector);
        l2Weth.burn(user, 1 ether);
        vm.stopPrank();
    }

    function test_tsb_credit_reverts_for_an_unregistered_token() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 1 ether});

        vm.prank(bridgeL2.l1BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridgeL2.TokenNotRegistered.selector, address(other)));
        bridgeL2.credit(address(other), credits);
    }

    // --- burning releases the L1 reserve in the same frame ---------------------

    /// @notice The plain withdrawal: burn on L2, release on L1 to the same
    /// address, one indivisible operation.
    function test_tsb_burn_releases_the_l1_reserve_in_the_same_frame() public {
        vm.prank(user);
        bridgeL2.burn(address(weth), user, 30 ether);

        assertEq(l2Weth.balanceOf(user), 70 ether, "representation burned");
        assertEq(weth.balanceOf(user), 30 ether, "L1 reserve released to the same address");
        assertEq(bridge.locked(address(weth)), _l2Supply(address(weth)), "reserve still equals supply");
    }

    /// @notice The settlement frame's outbound ERC-20 leg: the sell side is
    /// released to `SettlementRouter`, not to the order's owner (CT-5).
    function test_tsb_release_to_hands_the_sell_side_to_the_router() public {
        vm.prank(user);
        bridgeL2.releaseTo(address(weth), user, 25 ether, router);

        assertEq(l2Weth.balanceOf(user), 75 ether);
        assertEq(weth.balanceOf(router), 25 ether, "the router holds the residual's sell side");
        assertEq(bridge.locked(address(weth)), _l2Supply(address(weth)));
    }

    /// @notice `WindowBook` burns escrow it holds itself; a third party needs
    /// an allowance over the representation, exactly as an ERC-20 transfer does.
    function test_tsb_burn_requires_an_allowance_when_from_is_not_the_caller() public {
        vm.prank(router);
        vm.expectRevert();
        bridgeL2.releaseTo(address(weth), user, 10 ether, router);

        vm.prank(user);
        l2Weth.approve(router, 10 ether);

        vm.prank(router);
        bridgeL2.releaseTo(address(weth), user, 10 ether, router);

        assertEq(l2Weth.allowance(user, router), 0, "allowance spent");
        assertEq(weth.balanceOf(router), 10 ether);
    }

    /// @notice Free failure across the layers: when the L1 half of the frame
    /// reverts, the L2 burn goes with it. Nothing partial survives (FL-7).
    function test_tsb_a_failed_l1_release_reverts_the_l2_burn() public {
        vm.prank(guardian);
        bridge.pause();

        vm.prank(user);
        vm.expectRevert();
        bridgeL2.releaseTo(address(weth), user, 10 ether, router);

        assertEq(l2Weth.balanceOf(user), 100 ether, "no representation burned");
        assertEq(bridge.locked(address(weth)), 100 ether, "no reserve released");
        assertEq(bridge.locked(address(weth)), _l2Supply(address(weth)), "invariant intact after the failure");
    }

    // --- pausability -----------------------------------------------------------

    function test_tsb_pause_blocks_credit_and_burn() public {
        vm.prank(guardian);
        bridgeL2.pause();

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 1 ether});
        vm.prank(bridgeL2.l1BridgeProxy());
        vm.expectRevert(DexBridgeL2.EnforcedPause.selector);
        bridgeL2.credit(address(weth), credits);

        vm.prank(user);
        vm.expectRevert(DexBridgeL2.EnforcedPause.selector);
        bridgeL2.burn(address(weth), user, 1 ether);

        vm.prank(address(timelockL2));
        bridgeL2.unpause();

        vm.prank(user);
        bridgeL2.burn(address(weth), user, 1 ether);
    }

    // --- governance ------------------------------------------------------------

    function test_tsb_register_token_requires_governance(address caller) public {
        vm.assume(caller != address(timelockL2));
        MockERC20 other = new MockERC20("Other", "OTH", 18);

        vm.prank(caller);
        vm.expectRevert(DexBridgeL2.NotGovernance.selector);
        bridgeL2.registerToken(address(other), "eez Other", "eezOTH", 18);
    }

    /// @notice One representation per L1 token, forever: a second registration
    /// would split the supply the L1 reserve backs.
    function test_tsb_register_token_rejects_a_second_registration() public {
        vm.prank(address(timelockL2));
        vm.expectRevert(abi.encodeWithSelector(DexBridgeL2.TokenAlreadyRegistered.selector, address(weth)));
        bridgeL2.registerToken(address(weth), "eez Wrapped Ether", "eezWETH", 18);
    }

    function test_tsb_upgrade_requires_the_timelock_on_l2(address caller) public {
        vm.assume(caller != address(timelockL2));
        address newImplementation = address(new DexBridgeL2());

        vm.prank(caller);
        vm.expectRevert(DexBridgeL2.NotGovernance.selector);
        bridgeL2.upgradeToAndCall(newImplementation, "");

        _executeThroughTimelock(
            timelockL2, address(bridgeL2), abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (newImplementation, ""))
        );

        bytes32 slot = vm.load(address(bridgeL2), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);
        assertEq(address(uint160(uint256(slot))), newImplementation, "implementation upgraded");
    }

    function test_tsb_counterpart_can_only_be_set_once_on_l2() public {
        vm.prank(address(timelockL2));
        vm.expectRevert(DexBridgeL2.CounterpartAlreadySet.selector);
        bridgeL2.setL1Bridge(makeAddr("impostor"));
    }
}
