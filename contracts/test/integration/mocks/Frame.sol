// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {CrossChainProxy} from "eez-core-protocol/base/CrossChainProxy.sol";
import {IEEZ, ProxyInfo} from "eez-core-protocol/interfaces/IEEZ.sol";

/// @title The composed frame, as close to the framework as one EVM allows.
/// @notice Phase 6 part A: the soft contract every package mocked while it was
/// built is the *frame* — an L2 transaction whose L1 leg runs inside it, and
/// whose failure anywhere reverts all of it. Each package stubbed the half it
/// did not own. This is both halves at once.
///
/// The proxy is not a mock: it is `eez-core-protocol`'s own `CrossChainProxy`
/// at the revision `FRAMEWORK_COMMIT` pins, deployed by CREATE2 from the salt
/// the real registry uses. That matters for three things the DEX depends on
/// and no package could check alone:
///
/// - **the return path.** `executeCrossChainCall` returns `bytes`, so the raw
///   result is double-encoded and the proxy unwraps one layer. `WindowBook`
///   decodes `WindowResult[]` from what comes back (CT-2, A.2);
/// - **the value path.** The proxy has no `receive()`: ether sent with empty
///   calldata takes the same cross-chain path as a call, which is how the
///   router's unwrapped buy side reaches an L2 balance (CT-11);
/// - **identity.** `onlyZone` and `onlyBridgeProxy` are checked against an
///   address derived from the registry, not against a constant (CT-1, CT-5).
///
/// What is still a mock is the manager: there is no execution table, no proof
/// and no composer here, so any call is deliverable and eviction is modelled
/// by the revert that would cause it.
contract FrameManager is IEEZ {
    error NotAProxy();
    error NotPeer();
    error StaticPathUnused();

    /// @notice This chain's rollup id — 0 for L1, the zone's id on L2.
    uint64 public immutable ROLLUP_ID;

    /// @notice The manager on the other chain.
    FrameManager public peer;

    mapping(address proxy => ProxyInfo info) public proxyInfo;

    constructor(uint64 rollupId_) {
        ROLLUP_ID = rollupId_;
    }

    function setPeer(FrameManager peer_) external {
        peer = peer_;
    }

    /// @inheritdoc IEEZ
    function computeCrossChainProxyAddress(
        address originalAddress,
        uint64 originalRollupId
    )
        public
        view
        returns (address)
    {
        return
            Create2.computeAddress(_salt(originalAddress, originalRollupId), keccak256(_creationCode()), address(this));
    }

    /// @inheritdoc IEEZ
    function createCrossChainProxy(address originalAddress, uint64 originalRollupId) public returns (address proxy) {
        proxy = address(new CrossChainProxy{salt: _salt(originalAddress, originalRollupId)}(address(this)));
        proxyInfo[proxy] =
            ProxyInfo({isProxy: true, originalAddress: originalAddress, originalRollupId: originalRollupId});
    }

    /// @inheritdoc IEEZ
    /// @dev Outbound: `msg.sender` is one of this chain's proxies, and the
    /// address it stands for names the target on the peer chain.
    function executeCrossChainCall(
        address sourceAddress,
        bytes calldata callData
    )
        external
        payable
        returns (bytes memory)
    {
        ProxyInfo memory info = proxyInfo[msg.sender];
        if (!info.isProxy) revert NotAProxy();
        return peer.deliver{value: msg.value}(sourceAddress, ROLLUP_ID, info.originalAddress, callData);
    }

    /// @notice Inbound, from the peer manager: delivers the call through the
    /// local proxy that stands for `sourceAddress` on `sourceRollupId`, so the
    /// target sees that proxy as `msg.sender`.
    function deliver(
        address sourceAddress,
        uint64 sourceRollupId,
        address target,
        bytes calldata data
    )
        external
        payable
        returns (bytes memory)
    {
        if (msg.sender != address(peer)) revert NotPeer();
        address proxy = computeCrossChainProxyAddress(sourceAddress, sourceRollupId);
        if (proxy.code.length == 0) createCrossChainProxy(sourceAddress, sourceRollupId);

        // `executeOnBehalf` returns the destination's raw return data through
        // assembly, so it is read from the call rather than from a declared
        // return value. A revert is bubbled whole: the frame is atomic, and
        // what the caller sees is what the L1 leg reverted with (FL-7).
        (bool ok, bytes memory ret) =
            proxy.call{value: msg.value}(abi.encodeCall(CrossChainProxy.executeOnBehalf, (target, 0, data)));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    /// @inheritdoc IEEZ
    /// @dev Nothing in the DEX takes the static path: `settleWindow` is a
    /// state change and the mirror is read from L2 storage (CT-8, CT-14).
    function staticCrossChainCall(address, bytes calldata) external pure returns (bytes memory) {
        revert StaticPathUnused();
    }

    /// @inheritdoc IEEZ
    function RECOVERY_ADDRESS() external view returns (address) {
        return address(this);
    }

    function _creationCode() private view returns (bytes memory) {
        return abi.encodePacked(type(CrossChainProxy).creationCode, abi.encode(address(this)));
    }

    function _salt(address originalAddress, uint64 originalRollupId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(originalAddress, originalRollupId));
    }
}
