// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IEEZ} from "eez-core-protocol/interfaces/IEEZ.sol";

import {Credit, IDexBridge} from "../interfaces/IDexBridge.sol";
import {IDexBridgeL2} from "../interfaces/IDexBridgeL2.sol";

/// @title [full] DexBridge — the L1 reserve behind every L2 balance (WP-B, CT-5).
/// @notice The eez rail moves only ETH at the protocol layer, so the full form
/// ships its own bridge pair. This contract holds the locked ERC-20 reserves
/// that back `DexBridgeL2`'s supply one-for-one; every ERC-20 movement in the
/// settlement frame is an ordinary contract call through the framework's
/// `CrossChainProxy`, so a failure anywhere reverts the frame and it is
/// poison-evicted at zero L1 cost (CT-5, FL-7).
///
/// **This is custody of L1 reserves, not inventory** (EC-2). The reserve
/// invariant is
///
/// ```
/// per token: locked[token] == DexBridgeL2's total supply of its representation
/// ```
///
/// and it is enforced in code, not merely asserted in tests: `locked` moves
/// only in `release` (down, paired with an L2 burn in the same frame) and
/// `deposit` (up, paired with an L2 mint in the same frame), the contract
/// never releases outside a proxy-authorised frame, and `deposit` credits only
/// tokens that actually arrived.
///
/// Hardening beyond the framework's illustrative `periphery/Bridge.sol`
/// (RD-2 §12): the reserve invariant above, a per-token rolling **rate limit**
/// on release, **pausability** with a fast guardian, and **UUPS upgrade
/// authority held by a timelock** (whose proposers are the operator's
/// multisig). Custody is the second trust role in the system (EC-4).
///
/// @dev **AUDIT REQUIRED before any public testnet holds real value**
/// (RD-2 §12). Nothing in this contract has been audited.
///
/// @dev Deployed behind an ERC-1967 proxy; storage below is append-only.
contract DexBridge is IDexBridge, Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Per-token support flag and release rate limit.
    /// @dev `releaseLimitPerWindow` is default-deny: a supported token with a
    /// zero limit cannot release at all. `type(uint256).max` disables the
    /// limit and skips its accounting entirely.
    struct TokenConfig {
        bool supported;
        uint256 releaseLimitPerWindow;
        uint64 rateWindowStart;
        uint256 releasedInWindow;
    }

    // --- storage (append-only; this contract sits behind an ERC-1967 proxy) ---

    /// @notice The framework's L1 cross-chain manager — the registry the
    /// bridge proxy address is read from. Never hard-coded (RD-2 §3).
    IEEZ public manager;

    /// @notice The rollup id of the zone `DexBridgeL2` lives on.
    uint64 public zoneRollupId;

    /// @notice `DexBridgeL2`'s address on the zone.
    address public l2Bridge;

    /// @notice Upgrade and configuration authority: a timelock whose proposers
    /// are the operator's multisig (EC-4, RD-2 §12).
    address public governance;

    /// @notice May pause, and nothing else. Pausing is the fast path; only
    /// governance can unpause.
    address public guardian;

    /// @notice While true, no value moves in either direction.
    bool public paused;

    /// @notice Length in seconds of the rolling release rate-limit window.
    uint256 public rateLimitWindow;

    /// @notice Reserve locked per token — the L1 half of the reserve invariant.
    mapping(address token => uint256 amount) public locked;

    /// @notice Support flag and rate-limit state per token.
    mapping(address token => TokenConfig config) public tokenConfig;

    // --- errors ---------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedCaller();
    error CounterpartNotSet();
    error CounterpartAlreadySet();
    error NotGovernance();
    error NotPauser();
    error EnforcedPause();
    error TokenNotSupported(address token);
    error ShortReserve(address token, uint256 requested, uint256 available);
    error ReleaseRateLimited(address token, uint256 requested, uint256 remaining);
    error DepositNotDelivered(address token, uint256 expected, uint256 delivered);
    error CreditSumMismatch(uint256 expected, uint256 actual);
    error NoRecipients();
    error ProxyCallFailed(bytes reason);

    // --- events ---------------------------------------------------------------

    event BridgeConfigured(
        address indexed manager, uint64 indexed zoneRollupId, address indexed l2Bridge, address governance
    );
    event TokenSupportSet(address indexed token, bool supported, uint256 releaseLimitPerWindow);
    event RateLimitWindowSet(uint256 rateLimitWindow);
    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event GuardianSet(address indexed guardian);
    event BridgePaused(address indexed by);
    event BridgeUnpaused(address indexed by);
    event Released(address indexed token, address indexed to, uint256 amount);
    event Deposited(address indexed token, address indexed depositor, uint256 amount, uint256 recipientCount);

    // --- modifiers ------------------------------------------------------------

    /// @dev The sole caller of `release` is the L1-side `CrossChainProxy` the
    /// registry drives on behalf of `DexBridgeL2`. The address is computed
    /// from the framework registry, never stored as a constant.
    modifier onlyBridgeProxy() {
        if (l2Bridge == address(0)) revert CounterpartNotSet();
        if (msg.sender != l2BridgeProxy()) revert UnauthorizedCaller();
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

    /// @notice Wires the bridge to the framework registry and its counterpart.
    /// @param manager_ The framework's L1 cross-chain manager (`EEZ`).
    /// @param zoneRollupId_ The rollup id `DexBridgeL2` lives on.
    /// @param l2Bridge_ `DexBridgeL2`'s address on that rollup, or zero when
    /// it is not deployed yet — `setL2Bridge` fixes it once, afterwards.
    /// @param governance_ The timelock holding upgrade and config authority.
    /// @param guardian_ The address that may pause.
    /// @param rateLimitWindow_ Length in seconds of the release rate-limit window.
    function initialize(
        address manager_,
        uint64 zoneRollupId_,
        address l2Bridge_,
        address governance_,
        address guardian_,
        uint256 rateLimitWindow_
    )
        external
        initializer
    {
        if (manager_ == address(0)) revert ZeroAddress();
        if (governance_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (rateLimitWindow_ == 0) revert ZeroAmount();

        manager = IEEZ(manager_);
        zoneRollupId = zoneRollupId_;
        l2Bridge = l2Bridge_;
        governance = governance_;
        guardian = guardian_;
        rateLimitWindow = rateLimitWindow_;

        emit BridgeConfigured(manager_, zoneRollupId_, l2Bridge_, governance_);
        emit GuardianSet(guardian_);
        emit RateLimitWindowSet(rateLimitWindow_);
    }

    // --- the settlement frame -------------------------------------------------

    /// @inheritdoc IDexBridge
    /// @dev The outbound ERC-20 leg. `locked` is decremented against the L2
    /// burn that fired this call in the same frame, so the reserve invariant
    /// holds at every L2 safe head. A short reserve reverts, which reverts the
    /// frame and evicts it for free (CT-5).
    function release(address token, uint256 amount, address to) external onlyBridgeProxy whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        TokenConfig storage config = tokenConfig[token];
        if (!config.supported) revert TokenNotSupported(token);

        uint256 reserve = locked[token];
        if (amount > reserve) revert ShortReserve(token, amount, reserve);

        _consumeRateLimit(config, token, amount);

        locked[token] = reserve - amount;
        IERC20(token).safeTransfer(to, amount);

        emit Released(token, to, amount);
    }

    /// @inheritdoc IDexBridge
    /// @dev The inbound leg. Only tokens that actually arrived are locked and
    /// credited — the delivered amount is measured as the balance above the
    /// existing reserve, so a fee-on-transfer token cannot credit more than it
    /// delivered and a repeated or reentrant call finds no surplus and reverts.
    /// That is what makes a deposit credit exactly once.
    ///
    /// The L1->L2 credit is an ordinary call in the same frame, so its failure
    /// reverts everything (CT-5, CT-11).
    ///
    /// The caller must transfer `amount` in and call this atomically; the
    /// frozen interface carries no `from`, so the bridge cannot pull.
    function deposit(address token, uint256 amount, Credit[] calldata recipients) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (recipients.length == 0) revert NoRecipients();
        if (!tokenConfig[token].supported) revert TokenNotSupported(token);

        uint256 total;
        for (uint256 i = 0; i < recipients.length; ++i) {
            if (recipients[i].recipient == address(0)) revert ZeroAddress();
            if (recipients[i].amount == 0) revert ZeroAmount();
            total += recipients[i].amount;
        }
        if (total != amount) revert CreditSumMismatch(amount, total);

        uint256 reserve = locked[token];
        uint256 delivered = IERC20(token).balanceOf(address(this)) - reserve;
        if (delivered < amount) revert DepositNotDelivered(token, amount, delivered);

        locked[token] = reserve + amount;

        _crossChainCall(abi.encodeCall(IDexBridgeL2.credit, (token, recipients)));

        emit Deposited(token, msg.sender, amount, recipients.length);
    }

    // --- views ----------------------------------------------------------------

    /// @notice The L1 `CrossChainProxy` that represents `DexBridgeL2`: the sole
    /// authorised caller of `release`, and the address an L1->L2 call is made
    /// to. Read from the framework registry every time.
    function l2BridgeProxy() public view returns (address) {
        return manager.computeCrossChainProxyAddress(l2Bridge, zoneRollupId);
    }

    /// @notice How much of `token` may still be released in the current
    /// rate-limit window.
    function releasableThisWindow(address token) external view returns (uint256) {
        TokenConfig storage config = tokenConfig[token];
        if (!config.supported) return 0;
        if (config.releaseLimitPerWindow == type(uint256).max) return type(uint256).max;
        // The rate-limit window is hours long; a proposer's few seconds of
        // timestamp latitude cannot meaningfully advance it.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(config.rateWindowStart) + rateLimitWindow) return config.releaseLimitPerWindow;
        return config.releaseLimitPerWindow - config.releasedInWindow;
    }

    // --- governance -----------------------------------------------------------

    /// @notice Registers a token and sets its release rate limit. Default-deny:
    /// a zero limit supports deposits but permits no release.
    /// @param releaseLimitPerWindow Amount releasable per rate-limit window;
    /// `type(uint256).max` disables the limit.
    function setTokenSupport(address token, bool supported, uint256 releaseLimitPerWindow) external onlyGovernance {
        if (token == address(0)) revert ZeroAddress();
        TokenConfig storage config = tokenConfig[token];
        config.supported = supported;
        config.releaseLimitPerWindow = releaseLimitPerWindow;
        emit TokenSupportSet(token, supported, releaseLimitPerWindow);
    }

    /// @notice Names the counterpart, once. The pair is deployed on two
    /// chains, so one side's address cannot be known at the other's
    /// construction; this closes the cycle without ever letting a live bridge
    /// be repointed away from the reserves backing its L2 supply.
    function setL2Bridge(address l2Bridge_) external onlyGovernance {
        if (l2Bridge_ == address(0)) revert ZeroAddress();
        if (l2Bridge != address(0)) revert CounterpartAlreadySet();
        l2Bridge = l2Bridge_;
        emit BridgeConfigured(address(manager), zoneRollupId, l2Bridge_, governance);
    }

    function setRateLimitWindow(uint256 rateLimitWindow_) external onlyGovernance {
        if (rateLimitWindow_ == 0) revert ZeroAmount();
        rateLimitWindow = rateLimitWindow_;
        emit RateLimitWindowSet(rateLimitWindow_);
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

    /// @notice Halts every value movement. The guardian may pause immediately;
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

    /// @dev Rolling fixed-window limiter. The window resets lazily on the first
    /// release after it elapses, so an idle bridge costs nothing to keep.
    function _consumeRateLimit(TokenConfig storage config, address token, uint256 amount) private {
        uint256 limit = config.releaseLimitPerWindow;
        if (limit == type(uint256).max) return;

        uint256 used = config.releasedInWindow;
        // See `releasableThisWindow`: the window outlasts any timestamp drift.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(config.rateWindowStart) + rateLimitWindow) {
            config.rateWindowStart = uint64(block.timestamp);
            used = 0;
        }
        uint256 remaining = limit - used;
        if (amount > remaining) revert ReleaseRateLimited(token, amount, remaining);
        config.releasedInWindow = used + amount;
    }

    /// @dev Calls `DexBridgeL2` through its L1 proxy, deploying the proxy if it
    /// does not exist yet. Bubbles the revert reason: this runs inside the
    /// settlement frame, so a failure here reverts the whole composition.
    function _crossChainCall(bytes memory payload) private {
        if (l2Bridge == address(0)) revert CounterpartNotSet();
        address proxy = l2BridgeProxy();
        if (proxy.code.length == 0) manager.createCrossChainProxy(l2Bridge, zoneRollupId);

        (bool success, bytes memory reason) = proxy.call(payload);
        if (!success) revert ProxyCallFailed(reason);
    }

    /// @inheritdoc UUPSUpgradeable
    /// @dev Upgrade authority is the timelock (EC-4, RD-2 §12).
    function _authorizeUpgrade(address) internal override onlyGovernance {}
}
