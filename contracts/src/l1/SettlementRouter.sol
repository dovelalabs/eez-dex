// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEEZ} from "eez-core-protocol/interfaces/IEEZ.sol";

import {Credit, IDexBridge} from "../interfaces/IDexBridge.sol";
import {IPoolAdapter} from "../interfaces/IPoolAdapter.sol";
import {ISettlementRouter} from "../interfaces/ISettlementRouter.sol";
import {PoolState, Side, WindowLeg, WindowResult} from "../types/Types.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";

/// @notice One genesis recipient's share of the residual: the L1 address to
/// pay and the amount of the sell asset it contributed (CT-4).
/// @dev The wire form is RD-2's `(recipient, sellAmount)[]`; a struct array
/// and a tuple array of the same field types abi-encode identically, so
/// `WindowBook` may encode either.
struct Allocation {
    address recipient;
    uint256 sellAmount;
}

/// @title SettlementRouter — the L1 leg of one window (WP-1, CT-1 … CT-6).
/// @notice The zone-only entry point that executes a window's *residual*
/// against the real pool inside the atomic cross-layer frame and returns the
/// result the composer records. Everything it returns describes actual
/// execution: `P0` is the pool's spot read in-leg immediately before the swap,
/// the execution price is the swap's realised average, and `post` is the
/// pool's state after it (CT-2, FL-5).
///
/// **Both bounds of the price band are enforced** (CT-1). A move in the
/// residual's favour that breaks a *crossed* order's limit fails here, on L1,
/// where the revert is poison-evicted at zero cost — rather than filling
/// someone outside their limit (§12 changelog).
///
/// **Profile is configuration, never a fork** (§1). One deployment carries a
/// `DexBridge` and delivers ERC-20 output into L2 balances [full]; another
/// carries none and distributes on L1 per the leg's `distribution` [genesis].
/// Nothing else differs, and neither path can reach the other's code.
contract SettlementRouter is ISettlementRouter {
    using SafeERC20 for IERC20;

    /// @notice The caller is not the zone proxy the registry drives on behalf
    /// of `WindowBook` (CT-1).
    error NotZone(address caller);
    /// @notice `P0`, the pre-trade spot read in-leg, is outside the leg's band.
    error ReferencePriceOutsideBand(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);
    /// @notice The swap's realised average price is outside the leg's band.
    error ExecutionPriceOutsideBand(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);
    /// @notice A token that does not deliver what it is sent — fee-on-transfer
    /// or rebasing — cannot be settled: escrow and reserves are accounted in
    /// exact amounts (CT-13, TS-1).
    error UnsupportedToken(address token);
    /// @notice `msg.value` does not equal the ETH sell side of the legs.
    error ValueMismatch(uint256 received, uint256 required);
    /// @notice [genesis] The distribution's amounts do not sum to the residual.
    error DistributionMismatch(uint256 distributed, uint256 residualIn);
    /// @notice [genesis] A non-empty residual arrived with no distribution.
    error MissingDistribution();
    /// @notice [full] A leg carried a genesis distribution.
    error UnexpectedDistribution();
    /// @notice A native-value delivery was rejected by its recipient.
    error DeliveryFailed(address recipient, uint256 amount);
    /// @notice Only the wrapper may push ether here outside a settlement.
    error UnexpectedValue(address sender);

    uint256 internal constant Q96 = 1 << 96;

    /// @notice The framework's L1 cross-chain manager: the registry the zone
    /// proxy's address is read from, never hard-coded (§3).
    IEEZ public immutable eez;
    /// @notice The zone's rollup id in that registry.
    uint64 public immutable zoneRollupId;
    /// @notice `WindowBook`'s L2 address — the identity the zone proxy speaks
    /// for, and [full] the L2 account the bought asset is credited to.
    address public immutable windowBook;

    /// @notice The venue. One interface, so a second venue is a new adapter
    /// rather than a change here (CT-3).
    IPoolAdapter public immutable adapter;
    /// @notice The pair's A asset — the one `Side.SELL_A_FOR_B` sells.
    address public immutable tokenA;
    /// @notice The pair's B asset. Prices are B per A in Q96 (A.1).
    address public immutable tokenB;
    /// @notice The wrapper for the rail's native asset: a sell side that
    /// arrives as `msg.value` is wrapped into it, and a buy side that leaves
    /// as value is unwrapped from it.
    IWETH9 public immutable weth;
    /// @notice [full] The DEX's own bridge. The zero address selects the
    /// genesis form, where output is distributed on L1 instead (CT-4, CT-5).
    IDexBridge public immutable bridge;

    /// @dev True when A sorts first, which for a Uniswap-v3-shaped venue makes
    /// it `token0` — the orientation `PoolState.sqrtPriceX96` is quoted in.
    bool internal immutable A_IS_TOKEN0;

    constructor(
        IEEZ eez_,
        uint64 zoneRollupId_,
        address windowBook_,
        IPoolAdapter adapter_,
        address tokenA_,
        address tokenB_,
        IWETH9 weth_,
        IDexBridge bridge_
    ) {
        eez = eez_;
        zoneRollupId = zoneRollupId_;
        windowBook = windowBook_;
        adapter = adapter_;
        tokenA = tokenA_;
        tokenB = tokenB_;
        weth = weth_;
        bridge = bridge_;
        A_IS_TOKEN0 = tokenA_ < tokenB_;
    }

    /// @notice The L1-side proxy the registry drives on behalf of `WindowBook`
    /// — the sole caller of `settle`.
    function zoneProxy() public view returns (address) {
        return eez.computeCrossChainProxyAddress(windowBook, zoneRollupId);
    }

    /// @dev The sole caller is the zone proxy, read from the framework
    /// registry on every call so a proxy deployed later still authorises.
    modifier onlyZone() {
        if (msg.sender != zoneProxy()) revert NotZone(msg.sender);
        _;
    }

    /// @inheritdoc ISettlementRouter
    function settle(WindowLeg[] calldata legs) external payable onlyZone returns (WindowResult[] memory results) {
        results = new WindowResult[](legs.length);
        uint256 valueRequired;
        for (uint256 i = 0; i < legs.length; ++i) {
            uint256 legValue;
            (results[i], legValue) = _settleLeg(legs[i]);
            valueRequired += legValue;
        }
        // The composed frame carries the sell side as value; a mismatch means
        // the leg and the transfer disagree, so nothing settles.
        if (msg.value != valueRequired) revert ValueMismatch(msg.value, valueRequired);
    }

    /// @notice Unwrapped ether on its way to a recipient or to the zone.
    receive() external payable {
        if (msg.sender != address(weth)) revert UnexpectedValue(msg.sender);
    }

    // --- one leg ---------------------------------------------------------------

    /// @dev The order of checks is CT-1's: deadline, then `P0` against the
    /// band, then the swap, then the realised price against the band.
    /// @return result The leg's `WindowResult` (CT-2).
    /// @return legValue The ether this leg consumed from `msg.value`.
    function _settleLeg(WindowLeg calldata leg) internal returns (WindowResult memory result, uint256 legValue) {
        // A timestamp, checked on L1 where time is real: the L1 head is not
        // visible from L2 and the cross-chain format carries no block deadline.
        // The deadline is minutes wide (DEADLINE_SECONDS=24), so a validator's
        // second of drift cannot change the outcome — this is CT-1's check.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > leg.deadline) revert Expired();

        PoolState memory pre = adapter.quoteState();
        uint256 referencePriceX96 = _priceX96(pre.sqrtPriceX96);
        if (referencePriceX96 < leg.minPriceX96 || referencePriceX96 > leg.maxPriceX96) {
            revert ReferencePriceOutsideBand(referencePriceX96, leg.minPriceX96, leg.maxPriceX96);
        }

        // CT-6: a quiet window refreshes the mirror for one cross-layer call
        // and no swap. There is no impact to bear, so the realised price is
        // the reference price.
        if (leg.residualIn == 0) {
            return (
                WindowResult({
                    amountIn: 0,
                    amountOut: 0,
                    referencePriceX96: referencePriceX96,
                    executionPriceX96: referencePriceX96,
                    post: pre,
                    l1Block: uint64(block.number)
                }),
                0
            );
        }

        bool sellsA = leg.residualSide == Side.SELL_A_FOR_B;
        address sellToken = sellsA ? tokenA : tokenB;
        address buyToken = sellsA ? tokenB : tokenA;

        legValue = _acquireSellSide(sellToken, leg.residualIn);
        uint256 amountOut = _swap(leg, sellToken, buyToken);

        uint256 executionPriceX96 =
            sellsA ? Math.mulDiv(amountOut, Q96, leg.residualIn) : Math.mulDiv(leg.residualIn, Q96, amountOut);
        // Both bounds, so a favourable move that breaks a crossed order's
        // limit reverts here rather than filling it outside the limit (CT-1).
        if (executionPriceX96 < leg.minPriceX96 || executionPriceX96 > leg.maxPriceX96) {
            revert ExecutionPriceOutsideBand(executionPriceX96, leg.minPriceX96, leg.maxPriceX96);
        }

        PoolState memory post = adapter.quoteState();
        _deliver(leg, buyToken, amountOut);

        result = WindowResult({
            amountIn: leg.residualIn,
            amountOut: amountOut,
            referencePriceX96: referencePriceX96,
            executionPriceX96: executionPriceX96,
            post: post,
            l1Block: uint64(block.number)
        });
    }

    /// @dev A native sell side arrives as `msg.value` and is wrapped (CT-4,
    /// and CT-5's value path). An ERC-20 sell side is already here: [full]
    /// `DexBridge.release` ran earlier in this same L1 frame, and a short
    /// reserve reverted the frame before this point.
    function _acquireSellSide(address sellToken, uint256 residualIn) internal returns (uint256 legValue) {
        if (sellToken != address(weth)) return 0;
        weth.deposit{value: residualIn}();
        return residualIn;
    }

    /// @dev Pushes the residual to the adapter and swaps it, measuring both
    /// sides: a token that delivers less than it is sent would break the
    /// escrow and reserve accounting downstream, so it is rejected here.
    function _swap(WindowLeg calldata leg, address sellToken, address buyToken) internal returns (uint256 amountOut) {
        uint256 adapterBefore = IERC20(sellToken).balanceOf(address(adapter));
        IERC20(sellToken).safeTransfer(address(adapter), leg.residualIn);
        if (IERC20(sellToken).balanceOf(address(adapter)) - adapterBefore != leg.residualIn) {
            revert UnsupportedToken(sellToken);
        }

        // No floor is passed to the venue. CT-1 puts the limit on the leg's
        // *realised average price*, checked below against both bounds of the
        // band: a second, venue-side threshold could only differ from it by
        // rounding, and would mask the band error with a venue error. The
        // swap and the check are in one frame, so a swap the band rejects
        // reverts the whole settlement and is poison-evicted at zero L1 cost.
        uint256 boughtBefore = IERC20(buyToken).balanceOf(address(this));
        amountOut = adapter.swap(leg.residualSide, leg.residualIn, 0);
        if (IERC20(buyToken).balanceOf(address(this)) - boughtBefore != amountOut) {
            revert UnsupportedToken(buyToken);
        }
    }

    // --- delivery ---------------------------------------------------------------

    function _deliver(WindowLeg calldata leg, address buyToken, uint256 amountOut) internal {
        if (address(bridge) == address(0)) {
            // [genesis] CT-4: pay each recipient on L1 within this call.
            if (leg.distribution.length == 0) revert MissingDistribution();
            _distribute(leg, buyToken, amountOut);
            return;
        }

        // [full] CT-5: the buy side crosses back into L2 balances in-frame.
        if (leg.distribution.length != 0) revert UnexpectedDistribution();
        if (buyToken == address(weth)) {
            // ETH legs use the protocol's native value path in both directions.
            weth.withdraw(amountOut);
            _send(zoneProxy(), amountOut);
            return;
        }
        IERC20(buyToken).safeTransfer(address(bridge), amountOut);
        Credit[] memory credits = new Credit[](1);
        // `WindowBook` books every fill on L2 from the same `WindowResult`, so
        // the frame credits it once and it distributes to L2 balances.
        credits[0] = Credit({recipient: windowBook, amount: amountOut});
        bridge.deposit(buyToken, amountOut, credits);
    }

    /// @dev [genesis] Every genesis order is residual-side (FL-5), so each
    /// recipient's output is its share of the realised average price —
    /// `sellAmount * amountOut / residualIn`, rounded down. Rounding down per
    /// recipient is what keeps `Σ outputs ≤ amountOut`; the dust is the
    /// protocol's (CT-4, CT-12).
    function _distribute(WindowLeg calldata leg, address buyToken, uint256 amountOut) internal {
        Allocation[] memory allocations = abi.decode(leg.distribution, (Allocation[]));

        uint256 distributed;
        for (uint256 i = 0; i < allocations.length; ++i) {
            distributed += allocations[i].sellAmount;
        }
        if (distributed != leg.residualIn) revert DistributionMismatch(distributed, leg.residualIn);

        for (uint256 i = 0; i < allocations.length; ++i) {
            uint256 out = Math.mulDiv(allocations[i].sellAmount, amountOut, leg.residualIn);
            if (out != 0) IERC20(buyToken).safeTransfer(allocations[i].recipient, out);
        }
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert DeliveryFailed(to, amount);
    }

    // --- prices ------------------------------------------------------------------

    /// @dev B per A in Q96 from the venue's sorted-order sqrt price (A.1).
    function _priceX96(uint160 sqrtPriceX96) internal view returns (uint256 priceX96) {
        uint256 token1PerToken0 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
        priceX96 = A_IS_TOKEN0 ? token1PerToken0 : Math.mulDiv(Q96, Q96, token1PerToken0);
    }
}
