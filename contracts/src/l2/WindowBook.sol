// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEEZ} from "eez-core-protocol/interfaces/IEEZ.sol";

import {Credit} from "../interfaces/IDexBridge.sol";
import {IDexBridgeL2} from "../interfaces/IDexBridgeL2.sol";
import {ISettlementRouter} from "../interfaces/ISettlementRouter.sol";
import {IWindowBook} from "../interfaces/IWindowBook.sol";
import {Order, PoolState, Side, WindowLeg, WindowResult} from "../types/Types.sol";
import {Mirror} from "./Mirror.sol";

/// @notice Which build profile this deployment runs. Configuration, never a fork (RD-2 §1).
enum Profile {
    /// @notice Bidirectional calls; bought assets land in L2 balances in-frame (CT-11).
    FULL,
    /// @notice Atomic L2->L1 calls only; every order sells zone ETH, so there is no
    /// opposing flow and no crossing, and delivery is the L1 distribution (CT-4).
    GENESIS
}

/// @notice The two EC-1 fee shapes. Both are taken in the sell asset (CT-12).
enum FeeMode {
    /// @notice `FEE_BPS` — basis points of notional.
    BPS,
    /// @notice `FEE_FIXED` — a fixed amount per order, per asset.
    FIXED
}

/// @notice `ROUTE_FEE_MODEL`. `ABSORB` is the launch setting (EC-1); `RECOVER` is the
/// high-gas fallback that splits the window's route fee pro-rata by fill size.
enum RouteFeeModel {
    ABSORB,
    RECOVER
}

/// @notice The stored half of an order's A.4 state machine. `selected` and `rolled` are
/// transient within one `settleWindow` — a rolled order is simply still `OPEN`.
enum OrderStatus {
    NONE,
    OPEN,
    FILLED,
    CANCELLED,
    EXPIRED
}

/// @notice Everything a deployment configures. Profile, pair, fees and the framework
/// registry pointer; nothing here is a code path, so both profiles ship one bytecode.
struct BookConfig {
    Profile profile;
    /// @notice The framework's L2 manager (`EEZL2`). The zone proxy is *derived* from
    /// it, never hard-coded (RD-2 §3).
    address manager;
    /// @notice `SettlementRouter` on L1 — the cross-layer call's target.
    address router;
    /// @notice [full] `DexBridgeL2`, the L2 side of every ERC-20 movement (CT-11).
    address bridgeL2;
    /// @notice L2 address of A (the pool's `token0`); `address(0)` is native zone ETH.
    address assetA;
    /// @notice L2 address of B (the pool's `token1`); `address(0)` is native zone ETH.
    address assetB;
    /// @notice [full] A's L1 counterpart, for the bridge burn that backs a residual sell.
    address l1AssetA;
    /// @notice [full] B's L1 counterpart.
    address l1AssetB;
    FeeMode feeMode;
    /// @notice `FEE_BPS`. EC-1 caps it at the amortised gas saving on the median order.
    uint16 feeBps;
    /// @notice `FEE_FIXED` in A's units.
    uint256 feeFixedA;
    /// @notice `FEE_FIXED` in B's units.
    uint256 feeFixedB;
    RouteFeeModel routeFeeModel;
    /// @notice The window's route fee in wei, split pro-rata when `RECOVER` (CT-12).
    uint256 routeFeeWei;
    /// @notice `WINDOW_SLOTS` — 1 or 2 L1 slots per window (EC-6).
    uint8 windowSlots;
    /// @notice Explicit gas for the cross-layer call (A.5 `L1_GAS`).
    uint64 l1CallGas;
    address settler;
}

/// @title WindowBook — the L2 product surface (WP-2, CT-7 … CT-14).
/// @notice Order placement and escrow, quotes against the mirror, and — at the Sync
/// block — the crossing, the on-chain construction of the leg, the cross-layer call, and
/// the application of its result to every order.
///
/// **The contract, not the settler, is the last check.** `settleWindow` takes order ids
/// and nothing else: it rebuilds the selection from what is still open, computes the
/// cross and the residual, derives the price band, and enforces every order's
/// `minBuyAmount` against the price the L1 leg actually achieved (CT-9, CT-10). A
/// violation reverts the whole transaction, which is poison-evicted at compose time for
/// zero L1 gas (FL-7).
///
/// **Repricing risk sits with nobody (EC-2).** Reference-price clearing with impact
/// borne by the residual side means the protocol never holds a position: every asset
/// that enters is either escrowed, booked as fee or dust, credited to a user, or sent to
/// the L1 leg — the per-asset invariant of CT-13, asserted by `escrowInvariantDrift`.
contract WindowBook is IWindowBook, Ownable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants ---

    uint256 private constant Q96 = 0x1000000000000000000000000;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Mainnet's rollup id in the framework's cross-chain call hashes.
    uint64 private constant L1_ROLLUP_ID = 0;

    /// @notice L2 blocks in one L1 slot: 12 s / 2 s (RD-2 §1).
    uint32 private constant BLOCKS_PER_SLOT = 6;

    /// @notice Open orders the settlement sweep looks at, newest first. The sweep is a
    /// courtesy — `reclaim` releases any expired order at any time and anyone may call
    /// it — so it is bounded: an order book anyone can grow for the price of an escrow
    /// must not be able to make `settleWindow` run out of gas.
    uint256 private constant MAX_SWEEP = 64;

    // ------------------------------------------------------------ configuration ---

    Profile public immutable PROFILE;
    IEEZ public immutable MANAGER;
    address public immutable ROUTER;
    IDexBridgeL2 public immutable BRIDGE_L2;
    address public immutable ASSET_A;
    address public immutable ASSET_B;
    address public immutable L1_ASSET_A;
    address public immutable L1_ASSET_B;
    FeeMode public immutable FEE_MODE;
    uint16 public immutable FEE_BPS;
    uint256 public immutable FEE_FIXED_A;
    uint256 public immutable FEE_FIXED_B;
    RouteFeeModel public immutable ROUTE_FEE_MODEL;
    uint256 public immutable ROUTE_FEE_WEI;
    uint64 public immutable L1_CALL_GAS;

    // -------------------------------------------------------------------- state ---

    /// @notice The settler key. Rotatable by the owner (RD-2 §3).
    address public settler;

    /// @notice The open window's id. Advanced by every settlement (CT-9).
    uint64 public windowId;

    /// @notice The L2 block the open window started at, for `blocksRemaining` (CT-8).
    uint64 public windowStartBlock;

    /// @notice `WINDOW_SLOTS` in force for the open window (EC-6).
    uint8 public windowSlots;

    /// @notice `WINDOW_SLOTS` adopted at the next window boundary (EC-6).
    uint8 public pendingWindowSlots;

    /// @notice The working copy of the target mainnet pool (FL-1).
    PoolState public mirror;

    /// @notice The L2 timestamp the mirror was stamped at. The Sync block's timestamp
    /// equals the pinned L1 slot time, which is why age is derived from it (CT-8).
    uint64 public mirrorTimestamp;

    /// @notice The last settlement's `P0` (CT-14).
    uint256 public referencePriceX96;

    /// @notice The L1 block `referencePriceX96` was read in (CT-14).
    uint64 public referenceL1Block;

    mapping(bytes32 id => Order order) private _orders;
    mapping(bytes32 id => OrderStatus status) public statusOf;
    /// @notice The window an order was placed in; it expires after `expiresAfter` more.
    mapping(bytes32 id => uint64 window) public placedWindow;
    mapping(address owner => uint256 nonce) public nonces;

    bytes32[] private _openIds;
    mapping(bytes32 id => uint256 indexPlusOne) private _openIndex;

    /// @notice A user's L2 balance of an asset: bought assets delivered in-frame (CT-11)
    /// and escrow released by the expiry sweep. `withdraw` moves it out.
    mapping(address asset => mapping(address owner => uint256 amount)) public balanceOf;

    /// @notice The CT-13 ledger, per asset. `escrowed + fees + dust + credited` is
    /// everything the book holds; `deposits - released - withdrawn` is everything that
    /// came in less everything that went out. They are equal at every safe head.
    mapping(address asset => uint256 amount) public escrowed;
    mapping(address asset => uint256 amount) public feesAccrued;
    mapping(address asset => uint256 amount) public dustAccrued;
    mapping(address asset => uint256 amount) public credited;
    mapping(address asset => uint256 amount) public deposits;
    mapping(address asset => uint256 amount) public released;
    mapping(address asset => uint256 amount) public withdrawn;

    /// @dev Reentrancy lock. Transient: the settlement frame reenters L2 through the
    /// bridge credit, and a storage lock would pay for that on every window.
    bool private transient _entered;

    // ------------------------------------------------------------------- events ---

    /// @notice An order joined the open window (CT-7). The settler rebuilds window state
    /// from these logs across a restart (SV-5) and the indexer types them (IX-2).
    event OrderPlaced(
        bytes32 indexed id,
        address indexed owner,
        uint64 indexed window,
        Side side,
        uint256 sellAmount,
        uint256 minBuyAmount,
        address recipient,
        uint32 expiresAfter
    );

    /// @notice An open order was cancelled and its escrow released (CT-7).
    event OrderCancelled(bytes32 indexed id, address indexed owner, uint256 refund);

    /// @notice An expired order's escrow was released — by `reclaim`, or by the
    /// settlement sweep, which credits the owner's L2 balance rather than calling out.
    event OrderExpired(bytes32 indexed id, address indexed owner, uint256 refund, bool credited);

    /// @notice An L2 balance left the book (CT-7 [full]).
    event Withdrawn(address indexed asset, address indexed owner, uint256 amount);

    /// @notice The settler key rotated (RD-2 §3).
    event SettlerUpdated(address indexed previous, address indexed current);

    /// @notice `WINDOW_SLOTS` will change at the next window boundary (EC-6).
    event WindowSlotsScheduled(uint8 slots);

    // ------------------------------------------------------------------- errors ---

    error NotSettler();
    error InvalidConfiguration();
    error InvalidOrder();
    error UnknownOrder(bytes32 id);
    error OrderNotOpen(bytes32 id);
    error OrderNotExpired(bytes32 id);
    error NotOrderOwner(bytes32 id);
    /// @notice The sell asset is not the one this profile accepts. **[genesis]** every
    /// order sells zone ETH (FL-3).
    error UnsupportedSellAsset();
    /// @notice A token that delivered less than it was sent. Rejected outright: it would
    /// silently break CT-13.
    error FeeOnTransferToken();
    error ValueMismatch();
    error InsufficientBalance();
    error TransferFailed();
    /// @notice Nothing selectable remains — or the selection is too small to net, so it
    /// neither crosses nor leaves a residual — and there is nothing to settle. Raised
    /// before any L1 call (FL-7).
    error NothingToSettle();
    /// @notice `minPriceX96 > maxPriceX96`: no price satisfies every selected order.
    /// Raised before any L1 call (FL-7).
    error EmptyPriceBand(uint256 minPriceX96, uint256 maxPriceX96);
    /// @notice CT-10: the order's net output is below its limit. Reverts the whole
    /// transaction, which is poison-evicted for free.
    error LimitViolated(bytes32 id, uint256 amountOut, uint256 minBuyAmount);
    /// @notice The fees due exceed what the order sells, so it has nothing to trade.
    error FeeExceedsOrder(bytes32 id);
    /// @notice The L1 leg returned something other than one result for one leg.
    error MalformedResult();
    /// @notice The bought asset did not arrive in the settlement frame (CT-11 [full]).
    error DeliveryShortfall(uint256 expected, uint256 delivered);
    error Reentrancy();

    // ---------------------------------------------------------------- modifiers ---

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    // -------------------------------------------------------------- constructor ---

    /// @param cfg The deployment's configuration (profile, pair, fees, registry).
    /// @param initialOwner Rotates the settler key and `WINDOW_SLOTS`.
    /// @param genesisMirror The pool state the book opens with, so quotes work before
    /// the first settlement refreshes it (FL-1).
    constructor(BookConfig memory cfg, address initialOwner, PoolState memory genesisMirror) Ownable(initialOwner) {
        if (cfg.manager == address(0) || cfg.router == address(0)) revert InvalidConfiguration();
        if (cfg.assetA == cfg.assetB) revert InvalidConfiguration();
        if (cfg.windowSlots != 1 && cfg.windowSlots != 2) revert InvalidConfiguration();
        if (cfg.feeMode == FeeMode.BPS && cfg.feeBps > BPS_DENOMINATOR) revert InvalidConfiguration();
        // [genesis] every order sells zone ETH, so one leg of the pair must be it.
        if (cfg.profile == Profile.GENESIS && cfg.assetA != address(0) && cfg.assetB != address(0)) {
            revert InvalidConfiguration();
        }
        // [full] ERC-20 movement is the bridge's, so the pair's tokens need one.
        if (
            cfg.profile == Profile.FULL && cfg.bridgeL2 == address(0)
                && (cfg.assetA != address(0) || cfg.assetB != address(0))
        ) {
            revert InvalidConfiguration();
        }
        // The route fee is quoted in wei; recovering it from a non-ETH sell asset needs
        // the other leg of the pair to be ETH so there is a price to convert at (CT-12).
        if (cfg.routeFeeModel == RouteFeeModel.RECOVER && cfg.assetA != address(0) && cfg.assetB != address(0)) {
            revert InvalidConfiguration();
        }

        PROFILE = cfg.profile;
        MANAGER = IEEZ(cfg.manager);
        ROUTER = cfg.router;
        BRIDGE_L2 = IDexBridgeL2(cfg.bridgeL2);
        ASSET_A = cfg.assetA;
        ASSET_B = cfg.assetB;
        L1_ASSET_A = cfg.l1AssetA;
        L1_ASSET_B = cfg.l1AssetB;
        FEE_MODE = cfg.feeMode;
        FEE_BPS = cfg.feeBps;
        FEE_FIXED_A = cfg.feeFixedA;
        FEE_FIXED_B = cfg.feeFixedB;
        ROUTE_FEE_MODEL = cfg.routeFeeModel;
        ROUTE_FEE_WEI = cfg.routeFeeWei;
        L1_CALL_GAS = cfg.l1CallGas;

        settler = cfg.settler;
        windowSlots = cfg.windowSlots;
        pendingWindowSlots = cfg.windowSlots;
        windowStartBlock = uint64(block.number);
        mirror = genesisMirror;
        mirrorTimestamp = uint64(block.timestamp);
    }

    /// @notice Accepts the bought asset when it is native ETH: **[full]** the incoming
    /// call's `value` inside the settlement frame (CT-11), **[genesis]** nothing.
    /// @dev ETH sent outside a settlement is not credited to anyone; the CT-13 ledger
    /// tracks what the book booked, not what someone pushed at it.
    receive() external payable {}

    // ---------------------------------------------------- CT-7 · order lifecycle ---

    /// @inheritdoc IWindowBook
    function place(Order calldata o) external payable nonReentrant returns (bytes32 id) {
        if (o.sellAmount == 0 || o.recipient == address(0)) revert InvalidOrder();

        address sellAsset = _sellAsset(o.side);
        // [genesis] the sell asset is zone ETH, carried as `value` (FL-3).
        if (PROFILE == Profile.GENESIS && sellAsset != address(0)) revert UnsupportedSellAsset();

        uint256 fee = _protocolFee(o.sellAmount, o.side);
        if (o.sellAmount <= fee) revert InvalidOrder();

        // The id is derived on-chain, never user-supplied (CT-7).
        uint256 nonce = nonces[msg.sender]++;
        id = keccak256(abi.encodePacked(msg.sender, nonce));

        _takeEscrow(sellAsset, o.sellAmount);

        _orders[id] = Order({
            id: id,
            owner: msg.sender,
            side: o.side,
            sellAmount: o.sellAmount,
            minBuyAmount: o.minBuyAmount,
            recipient: o.recipient,
            expiresAfter: o.expiresAfter
        });
        statusOf[id] = OrderStatus.OPEN;
        placedWindow[id] = windowId;
        _openIds.push(id);
        _openIndex[id] = _openIds.length;

        emit OrderPlaced(id, msg.sender, windowId, o.side, o.sellAmount, o.minBuyAmount, o.recipient, o.expiresAfter);
    }

    /// @inheritdoc IWindowBook
    function cancel(bytes32 id) external nonReentrant {
        Order storage o = _orders[id];
        if (statusOf[id] != OrderStatus.OPEN) revert OrderNotOpen(id);
        if (o.owner != msg.sender) revert NotOrderOwner(id);

        uint256 refund = o.sellAmount;
        _closeOrder(id, OrderStatus.CANCELLED);
        _releaseEscrow(_sellAsset(o.side), o.owner, refund);
        emit OrderCancelled(id, o.owner, refund);
    }

    /// @inheritdoc IWindowBook
    function reclaim(bytes32 id) external nonReentrant {
        Order storage o = _orders[id];
        if (statusOf[id] != OrderStatus.OPEN) revert OrderNotOpen(id);
        if (!_isExpired(id, windowId)) revert OrderNotExpired(id);

        uint256 refund = o.sellAmount;
        address owner_ = o.owner;
        _closeOrder(id, OrderStatus.EXPIRED);
        _releaseEscrow(_sellAsset(o.side), owner_, refund);
        emit OrderExpired(id, owner_, refund, false);
    }

    /// @inheritdoc IWindowBook
    function withdraw(address asset, uint256 amount) external nonReentrant {
        uint256 balance = balanceOf[asset][msg.sender];
        if (amount == 0 || amount > balance) revert InsufficientBalance();

        balanceOf[asset][msg.sender] = balance - amount;
        credited[asset] -= amount;
        withdrawn[asset] += amount;
        _payOut(asset, msg.sender, amount);
        emit Withdrawn(asset, msg.sender, amount);
    }

    // ------------------------------------------------------------- CT-8 · views ---

    /// @inheritdoc IWindowBook
    function quote(
        uint256 sellAmount,
        Side side
    )
        external
        view
        returns (uint256 amountOut, uint32 mirrorAgeSlots, uint32 blocksRemaining)
    {
        amountOut = Mirror.quote(mirror, sellAmount, side);
        mirrorAgeSlots = Mirror.ageSlots(uint64(block.timestamp), mirrorTimestamp);
        blocksRemaining = _blocksRemaining();
    }

    /// @notice The mirror exposed as a price for other L2 contracts (CT-14).
    /// @dev **Read this first.** Its trust is this contract's storage plus the
    /// `SYSTEM_ADDRESS`-only `loadExecutionTable` path: L1 return data is *not*
    /// verifiable from L2 (`ANSWERS.md` Q4), so what you are trusting is that the eez
    /// node loaded the execution table honestly and that this contract stored what the
    /// leg returned. It is a **spot read of one pool**, taken inside the L1 leg
    /// immediately before the swap, and it is movable by anyone who can reorder within
    /// that single L1 block. It is not a TWAP, it is not continuous — it updates when a
    /// window settles — and no freshness service exists behind it. `mirrorAgeSlots` is
    /// returned so a consumer can price that staleness itself.
    /// @return referencePrice The last settlement's `P0`, B per A in Q96.
    /// @return l1Block The L1 block it was read in.
    /// @return mirrorAgeSlots Its age, `(block.timestamp - mirrorTimestamp) / 12`.
    function latestPrice() external view returns (uint256 referencePrice, uint64 l1Block, uint32 mirrorAgeSlots) {
        return (referencePriceX96, referenceL1Block, Mirror.ageSlots(uint64(block.timestamp), mirrorTimestamp));
    }

    /// @notice The order behind an id, whatever its status.
    function orderOf(bytes32 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// @notice Every id still open, in placement order.
    function openOrderIds() external view returns (bytes32[] memory) {
        return _openIds;
    }

    function openOrderCount() external view returns (uint256) {
        return _openIds.length;
    }

    /// @notice L2 blocks left in the open window (CT-8, EC-6).
    function windowBlocksRemaining() external view returns (uint32) {
        return _blocksRemaining();
    }

    /// @notice CT-13, per asset: `escrow + fees + dust + credited` less
    /// `deposits - released - withdrawn`. **Must be zero at every L2 safe head**; it is
    /// the settler's `escrow_invariant_drift_wei` (A.5).
    /// @dev The `credited` term is the L2 balance bucket CT-11 delivery books into. A.4
    /// predates it; without it the identity cannot hold once the book holds balances,
    /// and with it the statement is the stronger one — nothing the book holds is
    /// unaccounted, and nothing accounted for is missing.
    function escrowInvariantDrift(address asset) public view returns (int256) {
        uint256 held = escrowed[asset] + feesAccrued[asset] + dustAccrued[asset] + credited[asset];
        uint256 net = deposits[asset] - released[asset] - withdrawn[asset];
        // casting to 'int256' is safe because both sides are sums of token balances,
        // which cannot approach 2**255 without the token itself having overflowed
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(held) - int256(net);
    }

    // ------------------------------------------------------- CT-9 · settlement ---

    /// @notice The cross-layer entry point. Settler-only, and it MUST be sent to the
    /// L2->L1 front — a submission property no L2 contract can check.
    /// @inheritdoc IWindowBook
    function settleWindow(bytes32[] calldata orderIds, uint64 deadline) external onlySettler nonReentrant {
        Selection memory sel = _select(orderIds);
        if (sel.count == 0) revert NothingToSettle();
        _chargeFees(sel);

        BuiltLeg memory built = _buildLeg(sel, deadline);
        WindowResult memory result = _callL1(built);
        _applyResult(sel, built, result);
    }

    /// @inheritdoc IWindowBook
    function setSettler(address newSettler) external onlyOwner {
        emit SettlerUpdated(settler, newSettler);
        settler = newSettler;
    }

    /// @notice Schedules `WINDOW_SLOTS` for the next window boundary (EC-6).
    /// @dev Switched at the boundary, never mid-window: `blocksRemaining` would jump
    /// under a countdown the frontend is already drawing.
    function setWindowSlots(uint8 slots) external onlyOwner {
        if (slots != 1 && slots != 2) revert InvalidConfiguration();
        pendingWindowSlots = slots;
        emit WindowSlotsScheduled(slots);
    }

    // ------------------------------------------------------- settlement internals ---

    /// @dev One window's selection, carried through settlement in memory. Parallel
    /// arrays rather than a struct array: `settleWindow` walks them four times and the
    /// per-order struct would be re-read from memory each pass.
    struct Selection {
        bytes32[] ids;
        uint256 count;
        bool[] sideA;
        uint256[] sellAmount;
        uint256[] netIn;
        uint256[] fee;
        uint256[] routeFee;
        uint256 sumA; // Σ netIn on the A side
        uint256 sumB; // Σ netIn on the B side
    }

    /// @dev The leg the *contract* built, plus what the split implies for the fills.
    struct BuiltLeg {
        WindowLeg leg;
        /// @notice True when the residual side is `SELL_A_FOR_B`.
        bool residualIsA;
        /// @notice What the crossed side collectively receives, in its buy asset. Fixed
        /// here because the residual sent to L1 is fixed here.
        uint256 crossPot;
    }

    /// @dev Drops any id that is not open or has expired; duplicates drop with it. The
    /// settler's list is a suggestion, never an instruction (FL-8) — this is what makes
    /// a cancel landing in the Sync block shrink the selection instead of reverting it
    /// (CT-7, CT-9).
    function _select(bytes32[] calldata orderIds) private view returns (Selection memory sel) {
        uint256 n = orderIds.length;
        sel.ids = new bytes32[](n);
        sel.sideA = new bool[](n);
        sel.sellAmount = new uint256[](n);
        sel.netIn = new uint256[](n);
        sel.fee = new uint256[](n);
        sel.routeFee = new uint256[](n);

        uint64 currentWindow = windowId;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 id = orderIds[i];
            if (statusOf[id] != OrderStatus.OPEN) continue;
            if (_isExpired(id, currentWindow)) continue;
            // A duplicate id would fill the same order twice; the list is a window's
            // selection, so a linear scan is the cheapest way to reject one.
            bool seen = false;
            for (uint256 j = 0; j < sel.count; ++j) {
                if (sel.ids[j] == id) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;

            Order storage o = _orders[id];
            uint256 k = sel.count++;
            sel.ids[k] = id;
            sel.sideA[k] = o.side == Side.SELL_A_FOR_B;
            sel.sellAmount[k] = o.sellAmount;
        }
    }

    /// @dev EC-1's fee, plus the route fee split pro-rata by fill size when `RECOVER`.
    /// Both are taken in the sell asset (CT-12) and both come off the *input*, so the
    /// netting, the price band and every limit are all computed net of them — which is
    /// what makes `minBuyAmount` mean what a user thinks it means.
    function _chargeFees(Selection memory sel) private view {
        uint256 count = sel.count;
        uint256 routeTotal;
        uint256 notionalTotal;
        uint256[] memory notional;

        if (ROUTE_FEE_MODEL == RouteFeeModel.RECOVER && ROUTE_FEE_WEI != 0) {
            // Sizes on the two sides are in different units, so pro-rata needs one
            // scale: A-equivalents at the mirror price.
            uint256 priceX96 = Mirror.spotPriceX96(mirror);
            notional = new uint256[](count);
            for (uint256 i = 0; i < count; ++i) {
                notional[i] = sel.sideA[i] ? sel.sellAmount[i] : Math.mulDiv(sel.sellAmount[i], Q96, priceX96);
                notionalTotal += notional[i];
            }
            routeTotal = ROUTE_FEE_WEI;
        }

        for (uint256 i = 0; i < count; ++i) {
            Side side = sel.sideA[i] ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
            uint256 fee = _protocolFee(sel.sellAmount[i], side);
            uint256 routeFee;
            if (notionalTotal != 0) {
                routeFee = _routeFeeInSellAsset(Math.mulDiv(routeTotal, notional[i], notionalTotal), side);
            }
            if (fee + routeFee >= sel.sellAmount[i]) revert FeeExceedsOrder(sel.ids[i]);

            sel.fee[i] = fee;
            sel.routeFee[i] = routeFee;
            uint256 netIn = sel.sellAmount[i] - fee - routeFee;
            sel.netIn[i] = netIn;
            if (sel.sideA[i]) sel.sumA += netIn;
            else sel.sumB += netIn;
        }
    }

    /// @dev FL-4's cross and residual, then CT-9's price band.
    ///
    /// The crossed volume is fixed **here**, before the L1 call, because `residualIn` is:
    /// the two are the same number seen from opposite sides (`Σ netIn = residual +
    /// cross`). The only price available at that moment is the mirror's, so the mirror
    /// price is what the window nets at, and the residual side carries the whole
    /// difference between that and the `P0` the leg returns — reported per order as
    /// `impactAmount`. In the steady state the two are the same price and CT-9's
    /// "crossed orders fill at `P0`" holds exactly; under drift the crossed side is
    /// insulated (it gets the price the window was quoted at, so watching L2 order flow
    /// and taking the opposite side still captures nothing, EC-3) and the residual side
    /// — which caused the swap — carries it. Any other split either leaves the protocol
    /// long or short an asset (EC-2) or reverts on every drift.
    function _buildLeg(Selection memory sel, uint64 deadline) private view returns (BuiltLeg memory built) {
        uint256 priceX96 = Mirror.spotPriceX96(mirror);
        uint256 residualIn;

        uint256 sumBinA = sel.sumB == 0 ? 0 : Math.mulDiv(sel.sumB, Q96, priceX96);
        if (sel.sumA >= sumBinA) {
            built.residualIsA = true;
            built.crossPot = sumBinA; // A paid to the B side
            residualIn = sel.sumA - sumBinA;
        } else {
            built.residualIsA = false;
            built.crossPot = Math.mulDiv(sel.sumA, priceX96, Q96); // B paid to the A side
            residualIn = sel.sumB - built.crossPot;
        }

        // A selection whose whole volume is worth less than one unit of the other asset
        // crosses nothing and swaps nothing: every fill would be zero and the input
        // would leave the CT-13 ledger without ever reaching a recipient, the L1 leg or
        // the dust bucket. Foreseeable on L2, so it reverts here rather than paying for
        // an empty leg (FL-7, CT-13).
        if (residualIn == 0 && built.crossPot == 0) revert NothingToSettle();

        (uint256 minPriceX96, uint256 maxPriceX96) = _priceBand(sel, _minBuyAmounts(sel));
        if (minPriceX96 > maxPriceX96) revert EmptyPriceBand(minPriceX96, maxPriceX96);

        built.leg = WindowLeg({
            windowId: windowId,
            residualSide: built.residualIsA ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A,
            residualIn: residualIn,
            minPriceX96: minPriceX96,
            maxPriceX96: maxPriceX96,
            deadline: deadline,
            distribution: _distribution(sel, built.residualIsA)
        });
    }

    /// @dev The tightest sell-side limit and the tightest buy-side limit among the
    /// selected orders, each already widened by that side's fee — the bounds are derived
    /// from `netIn`, so the pool price they demand is the one that leaves the user their
    /// limit *after* fees. The residual side is widened by nothing: impact is checked
    /// per order after execution (CT-9, CT-10).
    ///
    /// An A-side order needs `netIn * P / 2**96 >= minBuy`, a lower bound on P; a B-side
    /// order needs `netIn * 2**96 / P >= minBuy`, an upper one. An order with no limit
    /// bounds nothing.
    function _priceBand(
        Selection memory sel,
        uint256[] memory minBuyAmounts
    )
        private
        pure
        returns (uint256 minPriceX96, uint256 maxPriceX96)
    {
        maxPriceX96 = type(uint256).max;
        for (uint256 i = 0; i < sel.count; ++i) {
            uint256 minBuy = minBuyAmounts[i];
            if (minBuy == 0) continue;

            if (sel.sideA[i]) {
                uint256 bound = Math.mulDiv(minBuy, Q96, sel.netIn[i], Math.Rounding.Ceil);
                if (bound > minPriceX96) minPriceX96 = bound;
            } else {
                uint256 bound = Math.mulDiv(sel.netIn[i], Q96, minBuy);
                if (bound < maxPriceX96) maxPriceX96 = bound;
            }
        }
    }

    /// @dev **[genesis]** the leg carries `(recipient, sellAmount)[]` for the L1
    /// distribution (CT-4). The amount is the order's sell amount *as it enters the leg*
    /// — net of the fees withheld on L2 — because the router splits `residualIn`, and
    /// `Σ distribution` must equal it to the wei. **[full]** delivery is the bridge's,
    /// so the field is empty.
    function _distribution(Selection memory sel, bool residualIsA) private view returns (bytes memory) {
        if (PROFILE != Profile.GENESIS) return "";

        uint256 residualCount;
        for (uint256 i = 0; i < sel.count; ++i) {
            if (sel.sideA[i] == residualIsA) ++residualCount;
        }
        Credit[] memory credits = new Credit[](residualCount);
        uint256 k;
        for (uint256 i = 0; i < sel.count; ++i) {
            if (sel.sideA[i] != residualIsA) continue;
            credits[k++] = Credit({recipient: _orders[sel.ids[i]].recipient, amount: sel.netIn[i]});
        }
        return abi.encode(credits);
    }

    /// @dev The cross-layer call: `SettlementRouter.settle([leg])` through the proxy the
    /// framework registry derives for the router, with `value` on an ETH sell side and
    /// explicit gas. A revert anywhere here — `Expired`, the band, a short bridge
    /// reserve — reverts this transaction, which is poison-evicted at compose time for
    /// zero L1 gas (FL-7).
    function _callL1(BuiltLeg memory built) private returns (WindowResult memory result) {
        address sellAsset = built.residualIsA ? ASSET_A : ASSET_B;
        address buyAsset = built.residualIsA ? ASSET_B : ASSET_A;
        uint256 residualIn = built.leg.residualIn;

        // [full] the L1 frame releases the sell side from `DexBridge`'s reserve, so the
        // L2 representation must burn against it in the same frame.
        if (PROFILE == Profile.FULL && sellAsset != address(0) && residualIn != 0) {
            BRIDGE_L2.burn(built.residualIsA ? L1_ASSET_A : L1_ASSET_B, address(this), residualIn);
        }

        uint256 value = sellAsset == address(0) ? residualIn : 0;
        uint256 heldBefore = _selfBalance(buyAsset);

        WindowLeg[] memory legs = new WindowLeg[](1);
        legs[0] = built.leg;

        (bool ok, bytes memory ret) =
            _routerProxy().call{value: value, gas: L1_CALL_GAS}(abi.encodeCall(ISettlementRouter.settle, (legs)));
        if (!ok) _bubble(ret);

        WindowResult[] memory results = abi.decode(ret, (WindowResult[]));
        if (results.length != 1) revert MalformedResult();
        result = results[0];

        released[sellAsset] += residualIn;

        // [full] the bought asset arrived inside the frame — as a `DexBridgeL2` credit
        // or as the incoming call's `value` (CT-11). [genesis] it was distributed on L1.
        if (PROFILE == Profile.FULL) {
            uint256 delivered = _selfBalance(buyAsset) - heldBefore;
            if (delivered < result.amountOut) revert DeliveryShortfall(result.amountOut, delivered);
            deposits[buyAsset] += result.amountOut;
            // Anything over the leg's own output is not this window's; leave it out of
            // the ledger rather than crediting it to somebody.
        }
    }

    /// @dev Fills, CT-10, escrow, fees, the new mirror, the next window, the sweep.
    function _applyResult(Selection memory sel, BuiltLeg memory built, WindowResult memory result) private {
        uint256 p0 = result.referencePriceX96;
        if (p0 == 0) revert MalformedResult();

        // The residual side receives everything the crossed side sold plus the leg's
        // output; the crossed side receives the pot fixed when the leg was built. Both
        // pots are exhausted exactly, so no path leaves the protocol long or short
        // (EC-2) and the remainder is rounding dust (CT-12).
        uint256 residualPot = (built.residualIsA ? sel.sumB : sel.sumA) + result.amountOut;
        uint256 residualSum = built.residualIsA ? sel.sumA : sel.sumB;
        uint256 crossedSum = built.residualIsA ? sel.sumB : sel.sumA;

        uint256 residualPaid;
        uint256 crossPaid;

        for (uint256 i = 0; i < sel.count; ++i) {
            bool isResidual = sel.sideA[i] == built.residualIsA;
            uint256 amountOut = isResidual
                ? Math.mulDiv(residualPot, sel.netIn[i], residualSum)
                : Math.mulDiv(built.crossPot, sel.netIn[i], crossedSum);

            _fill(sel, i, amountOut, isResidual ? _impact(sel, i, amountOut, p0) : 0);

            if (isResidual) residualPaid += amountOut;
            else crossPaid += amountOut;
        }

        // CT-12: the sum of outputs never exceeds the leg's output plus crossed volume;
        // what is left is dust, and dust accrues to the protocol fee bucket.
        //
        // The crossed side is paid out of the residual side's escrow, which the book
        // holds in either profile. The residual side's pot is only on L2 in the full
        // form — **[genesis]** the router distributed it on L1 and its rounding dust
        // stayed with the protocol there (CT-4), so booking it here would credit the
        // ledger with an asset the book never received.
        if (PROFILE == Profile.FULL) {
            dustAccrued[built.residualIsA ? ASSET_B : ASSET_A] += residualPot - residualPaid;
        }
        dustAccrued[built.residualIsA ? ASSET_A : ASSET_B] += built.crossPot - crossPaid;

        emit WindowSettled(windowId, result);

        mirror = result.post;
        mirrorTimestamp = uint64(block.timestamp);
        referencePriceX96 = p0;
        referenceL1Block = result.l1Block;

        windowId += 1;
        windowStartBlock = uint64(block.number);
        windowSlots = pendingWindowSlots;

        _sweepExpired();
    }

    /// @dev One order's fill: CT-10 first, then escrow, fees and delivery.
    function _fill(Selection memory sel, uint256 i, uint256 amountOut, uint256 impactAmount) private {
        bytes32 id = sel.ids[i];
        Order storage o = _orders[id];
        if (amountOut < o.minBuyAmount) revert LimitViolated(id, amountOut, o.minBuyAmount);

        Side side = sel.sideA[i] ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
        address sellAsset = _sellAsset(side);
        address buyAsset = _buyAsset(side);

        escrowed[sellAsset] -= sel.sellAmount[i];
        feesAccrued[sellAsset] += sel.fee[i] + sel.routeFee[i];
        _closeOrder(id, OrderStatus.FILLED);

        // [full] delivery is an L2 balance credited in this same transaction (CT-11).
        // [genesis] the router paid the recipient on L1 inside the leg (CT-4).
        if (PROFILE == Profile.FULL) {
            balanceOf[buyAsset][o.recipient] += amountOut;
            credited[buyAsset] += amountOut;
        }

        emit OrderFilled(id, amountOut, sel.fee[i], sel.routeFee[i], impactAmount);
    }

    /// @dev What the residual side paid for causing the swap, in **sell-asset units**
    /// (CT-12): the part of its input that bought nothing at `P0`. Crossed orders never
    /// pay impact and never receive it as a windfall, so theirs is zero (FL-5, EC-3). A
    /// fill better than `P0` reports zero rather than a negative cost.
    function _impact(Selection memory sel, uint256 i, uint256 amountOut, uint256 p0) private pure returns (uint256) {
        Side side = sel.sideA[i] ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
        uint256 inputAtP0 =
            side == Side.SELL_A_FOR_B ? Math.mulDiv(amountOut, Q96, p0) : Math.mulDiv(amountOut, p0, Q96);
        return sel.netIn[i] > inputAtP0 ? sel.netIn[i] - inputAtP0 : 0;
    }

    /// @dev Releases expired orders' escrow into their owners' L2 balances. Bounded, and
    /// deliberately not a transfer: an owner whose fallback reverts must not be able to
    /// brick the settlement every other order in the window is riding on.
    function _sweepExpired() private {
        uint64 currentWindow = windowId;
        uint256 scanned;
        uint256 i = _openIds.length;
        while (i != 0 && scanned < MAX_SWEEP) {
            --i;
            ++scanned;
            bytes32 id = _openIds[i];
            if (!_isExpired(id, currentWindow)) continue;

            Order storage o = _orders[id];
            address asset = _sellAsset(o.side);
            uint256 refund = o.sellAmount;
            address owner_ = o.owner;

            _closeOrder(id, OrderStatus.EXPIRED);
            escrowed[asset] -= refund;
            balanceOf[asset][owner_] += refund;
            credited[asset] += refund;
            emit OrderExpired(id, owner_, refund, true);
        }
    }

    // ------------------------------------------------------------------ helpers ---

    function _sellAsset(Side side) private view returns (address) {
        return side == Side.SELL_A_FOR_B ? ASSET_A : ASSET_B;
    }

    function _buyAsset(Side side) private view returns (address) {
        return side == Side.SELL_A_FOR_B ? ASSET_B : ASSET_A;
    }

    function _minBuyAmounts(Selection memory sel) private view returns (uint256[] memory limits) {
        limits = new uint256[](sel.count);
        for (uint256 i = 0; i < sel.count; ++i) {
            limits[i] = _orders[sel.ids[i]].minBuyAmount;
        }
    }

    /// @dev EC-1's two shapes, both in the sell asset (CT-12).
    function _protocolFee(uint256 sellAmount, Side side) private view returns (uint256) {
        if (FEE_MODE == FeeMode.BPS) return Math.mulDiv(sellAmount, FEE_BPS, BPS_DENOMINATOR);
        return side == Side.SELL_A_FOR_B ? FEE_FIXED_A : FEE_FIXED_B;
    }

    /// @dev The route fee is quoted in wei. When the sell asset is not ETH it is
    /// converted at the mirror price — the only price that exists when the leg is built.
    /// CT-12 names `P0`, which the leg has not returned yet; in the steady state they
    /// are the same price, and at launch `ROUTE_FEE_MODEL=absorb` makes this path dead.
    function _routeFeeInSellAsset(uint256 amountWei, Side side) private view returns (uint256) {
        address sellAsset = _sellAsset(side);
        if (sellAsset == address(0)) return amountWei;
        // The configuration guarantees the other leg of the pair is ETH.
        uint256 priceX96 = Mirror.spotPriceX96(mirror);
        // ETH is B: wei -> A is a division by the price. ETH is A: wei -> B is a
        // multiplication.
        return side == Side.SELL_A_FOR_B ? Math.mulDiv(amountWei, Q96, priceX96) : Math.mulDiv(amountWei, priceX96, Q96);
    }

    function _isExpired(bytes32 id, uint64 currentWindow) private view returns (bool) {
        return currentWindow > placedWindow[id] + _orders[id].expiresAfter;
    }

    function _blocksRemaining() private view returns (uint32) {
        uint256 length = uint256(windowSlots) * BLOCKS_PER_SLOT;
        uint256 elapsed = block.number - windowStartBlock;
        // casting to 'uint32' is safe because length is at most 2 * BLOCKS_PER_SLOT
        // forge-lint: disable-next-line(unsafe-typecast)
        return elapsed >= length ? 0 : uint32(length - elapsed);
    }

    /// @dev The zone proxy is *derived* from the framework registry, never hard-coded
    /// (RD-2 §3). It is created on first use; the address is deterministic either way.
    function _routerProxy() private returns (address proxy) {
        proxy = MANAGER.computeCrossChainProxyAddress(ROUTER, L1_ROLLUP_ID);
        if (proxy.code.length == 0) MANAGER.createCrossChainProxy(ROUTER, L1_ROLLUP_ID);
    }

    function _selfBalance(address asset) private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /// @dev Escrow in. A token that delivers less than it was sent is rejected here
    /// rather than accounted for: fee-on-transfer breaks CT-13 silently.
    function _takeEscrow(address asset, uint256 amount) private {
        if (asset == address(0)) {
            if (msg.value != amount) revert ValueMismatch();
        } else {
            if (msg.value != 0) revert ValueMismatch();
            uint256 before = IERC20(asset).balanceOf(address(this));
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
            if (IERC20(asset).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
        }
        escrowed[asset] += amount;
        deposits[asset] += amount;
    }

    /// @dev Escrow out of the book entirely: a cancel or a reclaim.
    function _releaseEscrow(address asset, address to, uint256 amount) private {
        escrowed[asset] -= amount;
        released[asset] += amount;
        _payOut(asset, to, amount);
    }

    function _payOut(address asset, address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    /// @dev Moves an order out of the open set. The open set is a swap-and-pop array, so
    /// `_sweepExpired` walks it backwards and never skips an entry.
    function _closeOrder(bytes32 id, OrderStatus status) private {
        statusOf[id] = status;
        uint256 indexPlusOne = _openIndex[id];
        uint256 last = _openIds.length;
        if (indexPlusOne != last) {
            bytes32 moved = _openIds[last - 1];
            _openIds[indexPlusOne - 1] = moved;
            _openIndex[moved] = indexPlusOne;
        }
        _openIds.pop();
        delete _openIndex[id];
    }

    /// @dev Forwards the L1 leg's revert reason unchanged; the settler's reconciler
    /// needs to tell `Expired` from a broken band from a short bridge reserve.
    function _bubble(bytes memory reason) private pure {
        if (reason.length == 0) revert TransferFailed();
        assembly {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
