// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../../src/bridge/DexBridgeL2.sol";
import {Credit} from "../../src/interfaces/IDexBridge.sol";

import {MockEEZ} from "./mocks/MockCrossChain.sol";

/// @notice The WP-B deployment, as the full form runs it: both bridges behind
/// ERC-1967 proxies, upgrade and configuration authority held by a
/// `TimelockController` whose proposer and executor is the operator's
/// multisig, and both sides wired to the framework registry that derives the
/// cross-chain proxy identities (RD-2 §12, EC-4).
abstract contract BridgeFixture is Test {
    using SafeERC20 for IERC20;

    uint64 internal constant L1_ROLLUP_ID = 0;
    uint64 internal constant ZONE_ROLLUP_ID = 1337;
    uint256 internal constant RATE_LIMIT_WINDOW = 1 hours;
    uint256 internal constant TIMELOCK_DELAY = 2 days;
    uint256 internal constant NO_RATE_LIMIT = type(uint256).max;

    MockEEZ internal managerL1;
    MockEEZ internal managerL2;

    TimelockController internal timelockL1;
    TimelockController internal timelockL2;

    DexBridge internal bridge;
    DexBridgeL2 internal bridgeL2;

    /// @notice The operator's multisig: the timelock's sole proposer and
    /// executor on both chains.
    address internal multisig;
    address internal guardian;

    function _deployBridgePair() internal {
        multisig = makeAddr("multisig");
        guardian = makeAddr("guardian");

        managerL1 = new MockEEZ(L1_ROLLUP_ID);
        managerL2 = new MockEEZ(ZONE_ROLLUP_ID);
        managerL1.setPeer(managerL2);
        managerL2.setPeer(managerL1);

        timelockL1 = _deployTimelock();
        timelockL2 = _deployTimelock();

        // The pair lives on two chains, so neither address is knowable at the
        // other's construction: L1 comes up without a counterpart and the
        // timelock names it once L2 exists.
        bridge = DexBridge(
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

        bridgeL2 = DexBridgeL2(
            address(
                new ERC1967Proxy(
                    address(new DexBridgeL2()),
                    abi.encodeCall(
                        DexBridgeL2.initialize,
                        (address(managerL2), L1_ROLLUP_ID, address(bridge), address(timelockL2), guardian)
                    )
                )
            )
        );

        vm.prank(address(timelockL1));
        bridge.setL2Bridge(address(bridgeL2));
    }

    function _deployTimelock() private returns (TimelockController) {
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;
        return new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
    }

    /// @notice Supports `l1Token` on L1 and deploys its L2 representation.
    function _registerToken(
        address l1Token,
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint256 releaseLimitPerWindow
    )
        internal
        returns (address l2Token)
    {
        vm.prank(address(timelockL1));
        bridge.setTokenSupport(l1Token, true, releaseLimitPerWindow);
        vm.prank(address(timelockL2));
        l2Token = bridgeL2.registerToken(l1Token, name, symbol, decimals);
    }

    /// @notice Locks `amount` of `l1Token` already held by this test contract
    /// and credits the matching L2 representation to `to` — the inbound leg,
    /// driven exactly as the router drives it.
    function _depositTo(address l1Token, address to, uint256 amount) internal {
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: to, amount: amount});
        IERC20(l1Token).safeTransfer(address(bridge), amount);
        bridge.deposit(l1Token, amount, credits);
    }

    /// @notice The total supply of `l1Token`'s L2 representation — the L2 half
    /// of the reserve invariant.
    function _l2Supply(address l1Token) internal view returns (uint256) {
        address l2Token = bridgeL2.l2TokenFor(l1Token);
        return l2Token == address(0) ? 0 : IERC20(l2Token).totalSupply();
    }

    /// @notice Schedules and executes `data` on `target` through `timelock`,
    /// as the multisig would. Advances time past the delay.
    function _executeThroughTimelock(TimelockController timelock, address target, bytes memory data) internal {
        vm.startPrank(multisig);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        vm.stopPrank();
    }
}
