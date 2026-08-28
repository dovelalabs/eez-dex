// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {IEEZ, ProxyInfo} from "eez-core-protocol/interfaces/IEEZ.sol";

/// @notice A stand-in for the framework's `CrossChainProxy`, deployed via
/// CREATE2 by `MockEEZ` exactly as the real registry deploys the real one.
/// @dev Mirrors the real proxy's transparent pattern: the manager calling
/// `executeOnBehalf` gets direct forwarding, every other caller falls through
/// to the cross-chain path.
contract MockCrossChainProxy {
    address internal immutable MANAGER;

    constructor() {
        MANAGER = msg.sender;
    }

    fallback() external payable {
        _fallback();
    }

    receive() external payable {}

    /// @notice Delivers a call arriving from the counterpart chain, so the
    /// target sees this proxy as `msg.sender` — the identity `onlyBridgeProxy`
    /// checks against.
    function executeOnBehalf(address destination, bytes calldata data) external payable returns (bytes memory) {
        if (msg.sender != MANAGER) {
            _fallback();
            return "";
        }
        (bool success, bytes memory result) = destination.call{value: msg.value}(data);
        if (!success) {
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    /// @dev Outbound: hands the call to the manager, which routes it to the
    /// counterpart chain. The whole hop is one EVM call stack, so a revert on
    /// the far side reverts the frame here — the property the DEX relies on.
    function _fallback() internal {
        (bool success, bytes memory result) =
            MANAGER.call{value: msg.value}(abi.encodeCall(IEEZ.executeCrossChainCall, (msg.sender, msg.data)));
        if (success) result = abi.decode(result, (bytes));
        assembly {
            switch success
            case 0 { revert(add(result, 0x20), mload(result)) }
            default { return(add(result, 0x20), mload(result)) }
        }
    }
}

/// @notice A two-chain stand-in for the framework's cross-chain managers.
/// @dev Both chains live in one EVM: a `MockEEZ` per side, wired to each other
/// as peers. Proxy addresses are derived exactly as the framework derives them
/// — CREATE2 over `keccak256(originalAddress, originalRollupId)` from the
/// manager — so `onlyBridgeProxy` is exercised against a real registry lookup
/// rather than a hard-coded address.
///
/// What is real: proxy identity, the direction of every hop, and atomicity —
/// a revert anywhere in the frame reverts all of it. What is a mock: there is
/// no execution table, no proof, and no composer, so any call is deliverable.
contract MockEEZ is IEEZ {
    uint64 public immutable ROLLUP_ID;

    MockEEZ public peer;

    mapping(address proxy => ProxyInfo info) public proxyInfo;

    error NotAProxy();
    error NotPeer();

    constructor(uint64 rollupId_) {
        ROLLUP_ID = rollupId_;
    }

    function setPeer(MockEEZ peer_) external {
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
        return Create2.computeAddress(
            _salt(originalAddress, originalRollupId), keccak256(type(MockCrossChainProxy).creationCode), address(this)
        );
    }

    /// @inheritdoc IEEZ
    function createCrossChainProxy(address originalAddress, uint64 originalRollupId) public returns (address proxy) {
        proxy = address(new MockCrossChainProxy{salt: _salt(originalAddress, originalRollupId)}());
        proxyInfo[proxy] =
            ProxyInfo({isProxy: true, originalAddress: originalAddress, originalRollupId: originalRollupId});
    }

    /// @inheritdoc IEEZ
    /// @dev Outbound hop: `msg.sender` is one of this chain's proxies, which
    /// names the target address on the peer chain.
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

    /// @notice Inbound hop, called by the peer manager: routes the call through
    /// the local proxy that represents `sourceAddress` on `sourceRollupId`.
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
        return MockCrossChainProxy(payable(proxy)).executeOnBehalf{value: msg.value}(target, data);
    }

    /// @inheritdoc IEEZ
    function staticCrossChainCall(address, bytes calldata) external pure returns (bytes memory) {
        revert("MockEEZ: static path unused");
    }

    /// @inheritdoc IEEZ
    function RECOVERY_ADDRESS() external view returns (address) {
        return address(this);
    }

    function _salt(address originalAddress, uint64 originalRollupId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(originalAddress, originalRollupId));
    }
}
