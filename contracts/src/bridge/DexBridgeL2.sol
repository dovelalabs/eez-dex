// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IEEZ} from "eez-core-protocol/interfaces/IEEZ.sol";

import {Credit, IDexBridge} from "../interfaces/IDexBridge.sol";
import {IDexBridgeL2} from "../interfaces/IDexBridgeL2.sol";
import {DexBridgeToken} from "./DexBridgeToken.sol";

/// @title [full] DexBridgeL2 — the L2 side of every ERC-20 movement (WP-B, CT-11).
/// @notice Mints and burns the L2 representations of the tokens `DexBridge`
/// locks on L1. `WindowBook` escrows and credits these representations.
///
/// The L2 half of the reserve invariant `Σ locked == Σ L2 supply` (EC-4):
/// supply is created only by a credit arriving through `DexBridge`'s proxy —
/// which means the L1 reserve was locked first in the same frame — and is
/// destroyed only by `burn`/`releaseTo`, which fire the matching
/// `DexBridge.release` on L1 in the same frame. There is no path that mints
/// without locking or burns without releasing, so the two sides cannot drift.
///
/// @dev **AUDIT REQUIRED before any public testnet holds real value**
/// (RD-2 §12). Nothing in this contract has been audited.
///
/// @dev Deployed behind an ERC-1967 proxy; storage below is append-only. The
/// pair is upgraded symmetrically: `DexBridgeL2` mints against `DexBridge`'s
/// reserves, so its authority is the same timelock-and-multisig role.
contract DexBridgeL2 is IDexBridgeL2, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    // --- storage (append-only; this contract sits behind an ERC-1967 proxy) ---

    /// @notice The framework's L2 cross-chain manager (`EEZL2`) — the registry
    /// the bridge proxy address is read from. Never hard-coded (RD-2 §3).
    IEEZ public manager;

    /// @notice The rollup id `DexBridge` lives on; 0 for L1 mainnet.
    uint64 public l1RollupId;

    /// @notice `DexBridge`'s address on that rollup.
    address public l1Bridge;

    /// @notice Upgrade and configuration authority: a timelock whose proposers
    /// are the operator's multisig (EC-4, RD-2 §12).
    address public governance;

    /// @notice May pause, and nothing else.
    address public guardian;

    /// @notice While true, no representation is minted or burned.
    bool public paused;

    /// @notice The L2 representation of each bridged L1 token.
    mapping(address l1Token => address l2Token) internal _l2TokenFor;

    // --- errors ---------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedCaller();
    error CounterpartNotSet();
    error CounterpartAlreadySet();
    error NotGovernance();
    error NotPauser();
    error EnforcedPause();
    error TokenNotRegistered(address l1Token);
    error TokenAlreadyRegistered(address l1Token);
    error NoCredits();
    error ProxyCallFailed(bytes reason);

    // --- events ---------------------------------------------------------------

    event BridgeConfigured(
        address indexed manager, uint64 indexed l1RollupId, address indexed l1Bridge, address governance
    );
    event TokenRegistered(address indexed l1Token, address indexed l2Token);
    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event GuardianSet(address indexed guardian);
    event BridgePaused(address indexed by);
    event BridgeUnpaused(address indexed by);
    event Released(address indexed l1Token, address indexed from, address indexed l1Recipient, uint256 amount);

    // --- modifiers ------------------------------------------------------------

    /// @dev The sole caller of `credit` and `mint` is the L2-side
    /// `CrossChainProxy` the registry drives on behalf of `DexBridge`.
    modifier onlyBridgeProxy() {
        if (l1Bridge == address(0)) revert CounterpartNotSet();
        if (msg.sender != l1BridgeProxy()) revert UnauthorizedCaller();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    // --- initialisation -------------------------------------------------------

    constructor() {
        _disableInitializers();
    }

    /// @param manager_ The framework's L2 cross-chain manager (`EEZL2`).
    /// @param l1RollupId_ The rollup id `DexBridge` lives on; 0 for mainnet.
    /// @param l1Bridge_ `DexBridge`'s address on that rollup, or zero when it
    /// is not deployed yet — `setL1Bridge` fixes it once, afterwards.
    /// @param governance_ The timelock holding upgrade and config authority.
    /// @param guardian_ The address that may pause.
    function initialize(
        address manager_,
        uint64 l1RollupId_,
        address l1Bridge_,
        address governance_,
        address guardian_
    )
        external
        initializer
    {
        if (manager_ == address(0)) revert ZeroAddress();
        if (governance_ == address(0) || guardian_ == address(0)) revert ZeroAddress();

        manager = IEEZ(manager_);
        l1RollupId = l1RollupId_;
        l1Bridge = l1Bridge_;
        governance = governance_;
        guardian = guardian_;

        emit BridgeConfigured(manager_, l1RollupId_, l1Bridge_, governance_);
        emit GuardianSet(guardian_);
    }

    // --- delivery: the inbound half of the frame -------------------------------

    /// @inheritdoc IDexBridgeL2
    /// @dev The L1->L2 half of `IDexBridge.deposit`: `DexBridge` locked the
    /// reserve immediately before making this call, in the same frame, so the
    /// mint below is backed the instant it happens (CT-5, CT-11).
    function credit(address l1Token, Credit[] calldata credits) external onlyBridgeProxy whenNotPaused nonReentrant {
        if (credits.length == 0) revert NoCredits();
        DexBridgeToken token = _token(l1Token);

        for (uint256 i = 0; i < credits.length; ++i) {
            address recipient = credits[i].recipient;
            uint256 amount = credits[i].amount;
            if (recipient == address(0)) revert ZeroAddress();
            if (amount == 0) revert ZeroAmount();
            token.mint(recipient, amount);
            emit Minted(l1Token, recipient, amount);
        }
    }

    /// @inheritdoc IDexBridgeL2
    function mint(address l1Token, address to, uint256 amount) external onlyBridgeProxy whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _token(l1Token).mint(to, amount);
        emit Minted(l1Token, to, amount);
    }

    // --- withdrawal: the outbound half of the frame ----------------------------

    /// @inheritdoc IDexBridgeL2
    /// @dev A withdrawal is one indivisible operation: the burn on L2 and the
    /// `DexBridge.release` it fires on L1 are in the same frame, so the reserve
    /// invariant holds at every L2 safe head. Releasing to `from` is the plain
    /// withdrawal; `releaseTo` chooses the L1 recipient, which is what the
    /// settlement frame's sell side needs (CT-5).
    function burn(address l1Token, address from, uint256 amount) external {
        _burnAndRelease(l1Token, from, amount, from);
    }

    /// @notice Burns the L2 representation and releases the L1 reserve to
    /// `l1Recipient` — the outbound ERC-20 leg of the settlement frame, where
    /// `l1Recipient` is `SettlementRouter` (CT-5).
    /// @dev `from` must be `msg.sender` or have granted it an allowance over
    /// the representation. `WindowBook` holds escrowed representations itself,
    /// so it burns as `from`.
    function releaseTo(address l1Token, address from, uint256 amount, address l1Recipient) external {
        _burnAndRelease(l1Token, from, amount, l1Recipient);
    }

    // --- views ----------------------------------------------------------------

    /// @inheritdoc IDexBridgeL2
    function l2TokenFor(address l1Token) external view returns (address l2Token) {
        return _l2TokenFor[l1Token];
    }

    /// @notice The L2 `CrossChainProxy` that represents `DexBridge`: the sole
    /// authorised caller of `credit` and `mint`, and the address an L2->L1 call
    /// is made to. Read from the framework registry every time.
    function l1BridgeProxy() public view returns (address) {
        return manager.computeCrossChainProxyAddress(l1Bridge, l1RollupId);
    }

    // --- governance -----------------------------------------------------------

    /// @notice Deploys the L2 representation of `l1Token`. Decimals mirror the
    /// L1 token so amounts are the same integer on both chains.
    function registerToken(
        address l1Token,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    )
        external
        onlyGovernance
        returns (address l2Token)
    {
        if (l1Token == address(0)) revert ZeroAddress();
        if (_l2TokenFor[l1Token] != address(0)) revert TokenAlreadyRegistered(l1Token);

        l2Token = address(new DexBridgeToken(l1Token, name, symbol, decimals));
        _l2TokenFor[l1Token] = l2Token;
        emit TokenRegistered(l1Token, l2Token);
    }

    /// @notice Names the counterpart, once. See `DexBridge.setL2Bridge`.
    function setL1Bridge(address l1Bridge_) external onlyGovernance {
        if (l1Bridge_ == address(0)) revert ZeroAddress();
        if (l1Bridge != address(0)) revert CounterpartAlreadySet();
        l1Bridge = l1Bridge_;
        emit BridgeConfigured(address(manager), l1RollupId, l1Bridge_, governance);
    }

    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceTransferred(governance, newGovernance);
        governance = newGovernance;
    }

    function setGuardian(address guardian_) external onlyGovernance {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Halts minting and burning. The guardian may pause immediately;
    /// only governance can unpause.
    function pause() external {
        if (msg.sender != guardian && msg.sender != governance) revert NotPauser();
        paused = true;
        emit BridgePaused(msg.sender);
    }

    function unpause() external onlyGovernance {
        paused = false;
        emit BridgeUnpaused(msg.sender);
    }

    // --- internals ------------------------------------------------------------

    function _burnAndRelease(
        address l1Token,
        address from,
        uint256 amount,
        address l1Recipient
    )
        private
        whenNotPaused
        nonReentrant
    {
        if (from == address(0) || l1Recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        DexBridgeToken token = _token(l1Token);
        if (from != msg.sender) token.spendAllowance(from, msg.sender, amount);
        token.burn(from, amount);

        _crossChainCall(abi.encodeCall(IDexBridge.release, (l1Token, amount, l1Recipient)));

        emit Burned(l1Token, from, amount);
        emit Released(l1Token, from, l1Recipient, amount);
    }

    function _token(address l1Token) private view returns (DexBridgeToken) {
        address l2Token = _l2TokenFor[l1Token];
        if (l2Token == address(0)) revert TokenNotRegistered(l1Token);
        return DexBridgeToken(l2Token);
    }

    /// @dev Calls `DexBridge` through its L2 proxy, deploying the proxy if it
    /// does not exist yet. Bubbles the revert reason: this runs inside the
    /// settlement frame, so a failure here reverts the whole composition and
    /// the frame is poison-evicted at zero L1 cost.
    function _crossChainCall(bytes memory payload) private {
        if (l1Bridge == address(0)) revert CounterpartNotSet();
        address proxy = l1BridgeProxy();
        if (proxy.code.length == 0) manager.createCrossChainProxy(l1Bridge, l1RollupId);

        (bool success, bytes memory reason) = proxy.call(payload);
        if (!success) revert ProxyCallFailed(reason);
    }

    /// @inheritdoc UUPSUpgradeable
    /// @dev Upgrade authority is the timelock (EC-4, RD-2 §12).
    function _authorizeUpgrade(address) internal override onlyGovernance {}
}
