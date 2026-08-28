// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {IDexBridge} from "../../src/interfaces/IDexBridge.sol";
import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {IWETH9} from "../../src/l1/interfaces/IWETH9.sol";
import {Allocation, SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {Side, WindowLeg} from "../../src/types/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPool} from "../mocks/MockPool.sol";
import {MockDexBridge} from "./mocks/MockDexBridge.sol";
import {MockEEZ} from "./mocks/MockEEZ.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

/// @notice One pool, one adapter, one router, wired the way a deployment wires
/// them — shared by the genesis and full-form suites (TS-1).
///
/// Every suite runs twice, once with the pair's A asset as the pool's `token0`
/// and once as its `token1`. Price is B per A in Q96 whichever way the venue
/// sorts its tokens (A.1), so an orientation bug that a 1:1 pool would hide
/// shows up here as a reciprocal.
abstract contract L1Fixture is Test {
    uint256 internal constant Q96 = 1 << 96;

    uint64 internal constant ZONE_ROLLUP_ID = 7;
    /// @dev `WindowBook`'s address on the zone — an L2 address, never called here.
    address internal constant WINDOW_BOOK = address(0xB00C);
    /// @dev The L1-side proxy the registry drives on its behalf.
    address internal constant ZONE_PROXY = address(0x20E9);

    uint24 internal constant POOL_FEE = 3000;
    uint128 internal constant POOL_LIQUIDITY = 1e24;
    /// @dev `token1` per `token0` = 4, so an orientation flip is a factor of 16.
    uint160 internal constant POOL_SQRT_PRICE = uint160(2 * Q96);

    uint64 internal constant DEADLINE = 2_000_000_000;

    MockEEZ internal eez;
    MockWETH internal weth;
    MockERC20 internal usd;
    MockPool internal pool;
    UniswapV3Adapter internal adapter;
    SettlementRouter internal router;

    /// @dev The pair's A asset — the one `Side.SELL_A_FOR_B` sells. Always
    /// WETH here: the genesis form sells zone ETH by construction (§1, FL-3),
    /// and the full form's ETH leg is the same shape.
    address internal tokenA;
    address internal tokenB;

    /// @notice True in the orientation where A is the pool's `token0`.
    function _aIsToken0() internal pure virtual returns (bool);

    /// @notice [full] the bridge; the zero address selects the genesis form.
    function _bridge() internal virtual returns (IDexBridge);

    function setUp() public virtual {
        eez = new MockEEZ();
        eez.setProxy(WINDOW_BOOK, ZONE_ROLLUP_ID, ZONE_PROXY);

        usd = new MockERC20("Dollar", "USD", 18);
        weth = _deployWethOrdered(address(usd), _aIsToken0());
        // Test WETH is minted into the pool rather than wrapped into it, so
        // back it with the ether an unwrap on the buy side will ask for.
        vm.deal(address(weth), 1e30);
        tokenA = address(weth);
        tokenB = address(usd);

        pool = _deployPool(address(weth), address(usd), POOL_SQRT_PRICE, POOL_LIQUIDITY);
        adapter = new UniswapV3Adapter(address(pool), tokenA);
        router = new SettlementRouter(
            eez, ZONE_ROLLUP_ID, WINDOW_BOOK, adapter, tokenA, tokenB, IWETH9(address(weth)), _bridge()
        );

        vm.warp(DEADLINE - 1 hours);
    }

    // --- deployment helpers -----------------------------------------------------

    /// @dev A Uniswap v3 pool sorts its tokens, so which of the pair is
    /// `token0` is decided by their addresses. Redeploy until the address
    /// falls the way this run wants it.
    function _deployWethOrdered(address other, bool wantBelow) internal returns (MockWETH found) {
        for (uint256 i = 0; i < 128; ++i) {
            found = new MockWETH();
            if ((address(found) < other) == wantBelow) return found;
        }
        revert("fixture: no WETH address in the wanted order");
    }

    function _deployPool(
        address a,
        address b,
        uint160 sqrtPriceX96,
        uint128 liquidity
    )
        internal
        returns (MockPool deployed)
    {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        deployed = new MockPool(token0, token1, POOL_FEE, sqrtPriceX96, liquidity);
        // Deep enough that the curve, not the pool's balance, bounds a swap.
        MockERC20(token0).mint(address(deployed), 1e30);
        MockERC20(token1).mint(address(deployed), 1e30);
    }

    // --- leg helpers ------------------------------------------------------------

    /// @notice The pool's spot as the router reads it: B per A in Q96.
    function _spotPriceX96() internal view returns (uint256) {
        uint256 token1PerToken0 = (uint256(pool.sqrtPriceX96()) * uint256(pool.sqrtPriceX96())) / Q96;
        return _aIsToken0() ? token1PerToken0 : (Q96 * Q96) / token1PerToken0;
    }

    /// @notice A band of `toleranceBps` either side of the pool's spot — the
    /// shape `WindowBook` derives from the selected orders' limits (CT-9).
    function _band(uint256 toleranceBps) internal view returns (uint256 minPriceX96, uint256 maxPriceX96) {
        uint256 spot = _spotPriceX96();
        minPriceX96 = (spot * (10_000 - toleranceBps)) / 10_000;
        maxPriceX96 = (spot * (10_000 + toleranceBps)) / 10_000;
    }

    function _leg(
        Side side,
        uint256 residualIn,
        uint256 toleranceBps,
        bytes memory distribution
    )
        internal
        view
        returns (WindowLeg memory leg)
    {
        (uint256 minPriceX96, uint256 maxPriceX96) = _band(toleranceBps);
        leg = WindowLeg({
            windowId: 1,
            residualSide: side,
            residualIn: residualIn,
            minPriceX96: minPriceX96,
            maxPriceX96: maxPriceX96,
            deadline: DEADLINE,
            distribution: distribution
        });
    }

    function _legs(WindowLeg memory leg) internal pure returns (WindowLeg[] memory legs) {
        legs = new WindowLeg[](1);
        legs[0] = leg;
    }

    function _distribution(
        address[] memory recipients,
        uint256[] memory sellAmounts
    )
        internal
        pure
        returns (bytes memory)
    {
        Allocation[] memory allocations = new Allocation[](recipients.length);
        for (uint256 i = 0; i < recipients.length; ++i) {
            allocations[i] = Allocation({recipient: recipients[i], sellAmount: sellAmounts[i]});
        }
        return abi.encode(allocations);
    }

    /// @notice One recipient taking the whole residual.
    function _soleDistribution(address recipient, uint256 sellAmount) internal pure returns (bytes memory) {
        address[] memory recipients = new address[](1);
        uint256[] memory sellAmounts = new uint256[](1);
        recipients[0] = recipient;
        sellAmounts[0] = sellAmount;
        return _distribution(recipients, sellAmounts);
    }
}
