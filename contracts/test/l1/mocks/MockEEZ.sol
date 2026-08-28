// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IEEZ} from "eez-core-protocol/interfaces/IEEZ.sol";

/// @notice The framework registry, as much of it as `onlyZone` reads.
/// @dev `SettlementRouter` never hard-codes the zone proxy: it asks the
/// registry for the L1-side proxy of `WindowBook` on the zone (RD-2 §3). This
/// mock answers that one question so the unit suite can move the answer and
/// watch the gate follow it. Everything else reverts — the router calls it.
contract MockEEZ is IEEZ {
    error NotMocked();

    mapping(address originalAddress => mapping(uint64 rollupId => address proxy)) public proxyOf;

    function setProxy(address originalAddress, uint64 rollupId, address proxy) external {
        proxyOf[originalAddress][rollupId] = proxy;
    }

    function computeCrossChainProxyAddress(
        address originalAddress,
        uint64 originalRollupId
    )
        external
        view
        returns (address)
    {
        return proxyOf[originalAddress][originalRollupId];
    }

    function executeCrossChainCall(address, bytes calldata) external payable returns (bytes memory) {
        revert NotMocked();
    }

    function staticCrossChainCall(address, bytes calldata) external pure returns (bytes memory) {
        revert NotMocked();
    }

    function createCrossChainProxy(address, uint64) external pure returns (address) {
        revert NotMocked();
    }

    function RECOVERY_ADDRESS() external pure returns (address) {
        return address(0);
    }
}
