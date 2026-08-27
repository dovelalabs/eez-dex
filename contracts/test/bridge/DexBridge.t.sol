// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {DexBridgeToken} from "../../src/bridge/DexBridgeToken.sol";
import {Credit} from "../../src/interfaces/IDexBridge.sol";

import {MockERC20, MockERC20Decimals6, MockFeeOnTransferERC20} from "../mocks/MockERC20.sol";
import {BridgeFixture} from "./BridgeFixture.sol";
import {ReentrantL2Bridge} from "./mocks/ReentrantL2Bridge.sol";

/// @title TS-B — the `DexBridge` unit and fuzz suite (WP-B, CT-5, EC-4, RD-2 §12).
/// @notice Custody is the second trust role in the system, so every one of its
/// edges is pinned here: who may release, what a short reserve does, that a
/// deposit credits exactly once, and the whole hardening surface — rate limit,
/// pause, and timelock-only upgrade.
contract DexBridgeTest is BridgeFixture {
    using SafeERC20 for IERC20;

    MockERC20 internal weth;
    MockERC20Decimals6 internal usdc;

    address internal user = makeAddr("user");
    address internal router = makeAddr("router");

    function setUp() public {
        _deployBridgePair();

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20Decimals6("USD Coin", "USDC");

        _registerToken(address(weth), "eez Wrapped Ether", "eezWETH", 18, NO_RATE_LIMIT);
        _registerToken(address(usdc), "eez USD Coin", "eezUSDC", 6, NO_RATE_LIMIT);
    }

    // --- onlyBridgeProxy (TS-B) ------------------------------------------------

    /// @notice No caller other than the L2 bridge's proxy can release, under
    /// any input. The proxy address is derived from the framework registry,
    /// never hard-coded (CT-5, RD-2 §3).
    function test_tsb_only_bridge_proxy_rejects_every_other_caller(address caller, uint256 amount, address to) public {
        vm.assume(caller != bridge.l2BridgeProxy());

        weth.mint(address(this), 100 ether);
        _depositTo(address(weth), user, 100 ether);

        vm.prank(caller);
        vm.expectRevert(DexBridge.UnauthorizedCaller.selector);
        bridge.release(address(weth), amount, to);
    }

    /// @notice The proxy the registry derives for `DexBridgeL2` is the caller
    /// the frame actually produces, and it is accepted.
    function test_tsb_only_bridge_proxy_accepts_the_registry_proxy() public {
        weth.mint(address(this), 10 ether);
        _depositTo(address(weth), user, 10 ether);

        vm.prank(bridge.l2BridgeProxy());
        bridge.release(address(weth), 4 ether, router);

        assertEq(weth.balanceOf(router), 4 ether, "router holds the released sell side");
        assertEq(bridge.locked(address(weth)), 6 ether, "reserve fell by exactly the release");
    }

    // --- short reserve (TS-B, CT-5) --------------------------------------------

    /// @notice A release the reserve cannot cover reverts. In the frame that
    /// reverts the whole composition and it is poison-evicted at zero L1 cost.
    function test_tsb_release_reverts_on_short_reserve() public {
        weth.mint(address(this), 5 ether);
        _depositTo(address(weth), user, 5 ether);

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridge.ShortReserve.selector, address(weth), 5 ether + 1, 5 ether));
        bridge.release(address(weth), 5 ether + 1, router);

        assertEq(bridge.locked(address(weth)), 5 ether, "reserve untouched by the failed release");
    }

    /// @notice Tokens donated outside `deposit` are not reserve and cannot be
    /// released: the reserve is the accounted `locked`, never the balance.
    function test_tsb_release_ignores_unaccounted_balance() public {
        weth.mint(address(this), 5 ether);
        _depositTo(address(weth), user, 5 ether);
        weth.mint(address(bridge), 100 ether); // a donation, not a deposit

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridge.ShortReserve.selector, address(weth), 6 ether, 5 ether));
        bridge.release(address(weth), 6 ether, router);
    }

    function test_tsb_release_reverts_for_unsupported_token() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridge.TokenNotSupported.selector, address(other)));
        bridge.release(address(other), 1, router);
    }

    // --- deposit credits exactly once (TS-B, CT-11) ----------------------------

    function test_tsb_deposit_credits_exactly_once() public {
        weth.mint(address(this), 7 ether);
        _depositTo(address(weth), user, 7 ether);

        assertEq(bridge.locked(address(weth)), 7 ether, "reserve locked once");
        assertEq(_l2Supply(address(weth)), 7 ether, "L2 supply minted once");
        assertEq(IERC20(bridgeL2.l2TokenFor(address(weth))).balanceOf(user), 7 ether, "credited to the recipient");
    }

    /// @notice Replaying the same deposit finds no undelivered surplus and
    /// reverts, so no second credit is possible.
    function test_tsb_deposit_reverts_when_replayed_without_a_new_delivery() public {
        weth.mint(address(this), 7 ether);
        _depositTo(address(weth), user, 7 ether);

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 7 ether});
        vm.expectRevert(abi.encodeWithSelector(DexBridge.DepositNotDelivered.selector, address(weth), 7 ether, 0));
        bridge.deposit(address(weth), 7 ether, credits);

        assertEq(_l2Supply(address(weth)), 7 ether, "still credited exactly once");
    }

    /// @notice A counterpart that calls back into `deposit` from the inbound
    /// credit is refused, and the outer deposit reverts with it — the frame is
    /// all-or-nothing, so there is no partial credit to clean up.
    function test_tsb_deposit_reverts_on_reentrant_credit() public {
        DexBridge reentrantBridge = DexBridge(
            address(
                new ERC1967Proxy(
                    address(new DexBridge()),
                    abi.encodeCall(
                        DexBridge.initialize,
                        (
                            address(managerL1),
                            ZONE_ROLLUP_ID,
                            address(0),
                            address(timelockL1),
                            guardian,
                            RATE_LIMIT_WINDOW
                        )
                    )
                )
            )
        );
        ReentrantL2Bridge attacker = new ReentrantL2Bridge(reentrantBridge);

        vm.startPrank(address(timelockL1));
        reentrantBridge.setL2Bridge(address(attacker));
        reentrantBridge.setTokenSupport(address(weth), true, NO_RATE_LIMIT);
        vm.stopPrank();

        weth.mint(address(reentrantBridge), 3 ether);

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 3 ether});
        vm.expectRevert();
        reentrantBridge.deposit(address(weth), 3 ether, credits);

        assertEq(reentrantBridge.locked(address(weth)), 0, "no reserve locked by the reverted frame");
        assertEq(attacker.creditCalls(), 0, "the whole frame rolled back");
    }

    function test_tsb_deposit_rejects_a_credit_sum_that_is_not_the_amount() public {
        weth.mint(address(this), 10 ether);
        IERC20(address(weth)).safeTransfer(address(bridge), 10 ether);

        Credit[] memory credits = new Credit[](2);
        credits[0] = Credit({recipient: user, amount: 4 ether});
        credits[1] = Credit({recipient: router, amount: 5 ether});

        vm.expectRevert(abi.encodeWithSelector(DexBridge.CreditSumMismatch.selector, 10 ether, 9 ether));
        bridge.deposit(address(weth), 10 ether, credits);
    }

    function test_tsb_deposit_splits_across_recipients() public {
        weth.mint(address(this), 10 ether);
        IERC20(address(weth)).safeTransfer(address(bridge), 10 ether);

        Credit[] memory credits = new Credit[](2);
        credits[0] = Credit({recipient: user, amount: 4 ether});
        credits[1] = Credit({recipient: router, amount: 6 ether});
        bridge.deposit(address(weth), 10 ether, credits);

        IERC20 l2Weth = IERC20(bridgeL2.l2TokenFor(address(weth)));
        assertEq(l2Weth.balanceOf(user), 4 ether);
        assertEq(l2Weth.balanceOf(router), 6 ether);
        assertEq(bridge.locked(address(weth)), _l2Supply(address(weth)), "reserve backs the split one-for-one");
    }

    /// @notice A token that delivers less than it was sent can only credit what
    /// arrived: the reserve is measured, never assumed (CT-13).
    function test_tsb_deposit_credits_only_what_a_fee_on_transfer_token_delivered() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20("Fee", "FEE", 18, 100); // 1%
        _registerToken(address(fot), "eez Fee", "eezFEE", 18, NO_RATE_LIMIT);

        fot.mint(address(this), 100 ether);
        IERC20(address(fot)).safeTransfer(address(bridge), 100 ether); // 99 ether actually lands

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 100 ether});
        vm.expectRevert(
            abi.encodeWithSelector(DexBridge.DepositNotDelivered.selector, address(fot), 100 ether, 99 ether)
        );
        bridge.deposit(address(fot), 100 ether, credits);

        credits[0] = Credit({recipient: user, amount: 99 ether});
        bridge.deposit(address(fot), 99 ether, credits);
        assertEq(bridge.locked(address(fot)), _l2Supply(address(fot)), "reserve equals supply after the fee");
    }

    function test_tsb_deposit_reverts_for_unsupported_token() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(bridge), 1 ether);

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 1 ether});
        vm.expectRevert(abi.encodeWithSelector(DexBridge.TokenNotSupported.selector, address(other)));
        bridge.deposit(address(other), 1 ether, credits);
    }

    // --- rate limit (RD-2 §12) -------------------------------------------------

    function test_tsb_release_rate_limit_binds() public {
        vm.prank(address(timelockL1));
        bridge.setTokenSupport(address(weth), true, 10 ether);

        weth.mint(address(this), 100 ether);
        _depositTo(address(weth), user, 100 ether);

        vm.prank(bridge.l2BridgeProxy());
        bridge.release(address(weth), 6 ether, router);
        assertEq(bridge.releasableThisWindow(address(weth)), 4 ether, "the window's remainder");

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridge.ReleaseRateLimited.selector, address(weth), 5 ether, 4 ether));
        bridge.release(address(weth), 5 ether, router);
    }

    function test_tsb_release_rate_limit_resets_in_the_next_window() public {
        vm.prank(address(timelockL1));
        bridge.setTokenSupport(address(weth), true, 10 ether);

        weth.mint(address(this), 100 ether);
        _depositTo(address(weth), user, 100 ether);

        vm.prank(bridge.l2BridgeProxy());
        bridge.release(address(weth), 10 ether, router);

        vm.warp(block.timestamp + RATE_LIMIT_WINDOW);
        assertEq(bridge.releasableThisWindow(address(weth)), 10 ether, "window refilled");

        vm.prank(bridge.l2BridgeProxy());
        bridge.release(address(weth), 10 ether, router);
        assertEq(weth.balanceOf(router), 20 ether);
    }

    /// @notice Default-deny: a supported token with no limit configured cannot
    /// release at all.
    function test_tsb_release_rate_limit_defaults_to_denied() public {
        MockERC20 fresh = new MockERC20("Fresh", "FRSH", 18);
        _registerToken(address(fresh), "eez Fresh", "eezFRSH", 18, 0);

        fresh.mint(address(this), 1 ether);
        _depositTo(address(fresh), user, 1 ether);

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(abi.encodeWithSelector(DexBridge.ReleaseRateLimited.selector, address(fresh), 1, 0));
        bridge.release(address(fresh), 1, router);
    }

    // --- pausability (RD-2 §12) ------------------------------------------------

    function test_tsb_pause_blocks_release() public {
        weth.mint(address(this), 10 ether);
        _depositTo(address(weth), user, 10 ether);

        vm.prank(guardian);
        bridge.pause();

        vm.prank(bridge.l2BridgeProxy());
        vm.expectRevert(DexBridge.EnforcedPause.selector);
        bridge.release(address(weth), 1 ether, router);
    }

    function test_tsb_pause_blocks_deposit() public {
        weth.mint(address(this), 10 ether);
        IERC20(address(weth)).safeTransfer(address(bridge), 10 ether);

        vm.prank(guardian);
        bridge.pause();

        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: user, amount: 10 ether});
        vm.expectRevert(DexBridge.EnforcedPause.selector);
        bridge.deposit(address(weth), 10 ether, credits);
    }

    /// @notice The guardian's job is speed, not authority: it can pause but
    /// only governance can lift the pause.
    function test_tsb_only_governance_can_unpause(address caller) public {
        vm.assume(caller != address(timelockL1));

        vm.prank(guardian);
        bridge.pause();

        vm.prank(caller);
        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.unpause();

        vm.prank(address(timelockL1));
        bridge.unpause();
        assertFalse(bridge.paused());
    }

    function test_tsb_pause_rejects_callers_other_than_guardian_and_governance(address caller) public {
        vm.assume(caller != guardian && caller != address(timelockL1));

        vm.prank(caller);
        vm.expectRevert(DexBridge.NotPauser.selector);
        bridge.pause();
    }

    // --- upgrade authority (RD-2 §12, EC-4) ------------------------------------

    /// @notice Upgrade authority is the timelock alone — not the multisig
    /// directly, not the guardian, not anyone else.
    function test_tsb_upgrade_requires_the_timelock(address caller) public {
        vm.assume(caller != address(timelockL1));
        address newImplementation = address(new DexBridge());

        vm.prank(caller);
        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.upgradeToAndCall(newImplementation, "");
    }

    /// @notice The multisig proposes; the upgrade lands only after the delay.
    function test_tsb_upgrade_through_the_timelock_waits_out_the_delay() public {
        address newImplementation = address(new DexBridge());
        bytes memory call = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (newImplementation, ""));

        vm.startPrank(multisig);
        timelockL1.schedule(address(bridge), 0, call, bytes32(0), bytes32(0), TIMELOCK_DELAY);

        vm.expectRevert();
        timelockL1.execute(address(bridge), 0, call, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + TIMELOCK_DELAY);
        timelockL1.execute(address(bridge), 0, call, bytes32(0), bytes32(0));
        vm.stopPrank();

        bytes32 slot = vm.load(address(bridge), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);
        assertEq(address(uint160(uint256(slot))), newImplementation, "implementation upgraded");
    }

    /// @notice The implementation behind the proxy is not itself initialisable,
    /// so nobody can take it over and self-destruct the upgrade path.
    function test_tsb_implementation_cannot_be_initialised() public {
        DexBridge implementation = new DexBridge();
        vm.expectRevert();
        implementation.initialize(address(managerL1), ZONE_ROLLUP_ID, address(1), address(2), address(3), 1 hours);
    }

    // --- governance surface ----------------------------------------------------

    function test_tsb_governance_functions_reject_other_callers(address caller) public {
        vm.assume(caller != address(timelockL1));
        vm.startPrank(caller);

        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.setTokenSupport(address(weth), true, 1);
        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.setRateLimitWindow(1 days);
        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.transferGovernance(caller);
        vm.expectRevert(DexBridge.NotGovernance.selector);
        bridge.setGuardian(caller);

        vm.stopPrank();
    }

    /// @notice A live bridge can never be repointed away from the reserves
    /// backing its L2 supply.
    function test_tsb_counterpart_can_only_be_set_once() public {
        vm.prank(address(timelockL1));
        vm.expectRevert(DexBridge.CounterpartAlreadySet.selector);
        bridge.setL2Bridge(makeAddr("impostor"));
    }

    function test_tsb_l2_representation_mirrors_l1_decimals() public view {
        assertEq(DexBridgeToken(bridgeL2.l2TokenFor(address(usdc))).decimals(), 6, "USDC is six decimals on L2 too");
        assertEq(DexBridgeToken(bridgeL2.l2TokenFor(address(weth))).decimals(), 18);
    }
}
