// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../../src/bridge/DexBridgeL2.sol";
import {Credit, IDexBridge} from "../../src/interfaces/IDexBridge.sol";
import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {IWETH9} from "../../src/l1/interfaces/IWETH9.sol";
import {SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {BookConfig, FeeMode, Profile, RouteFeeModel, WindowBook} from "../../src/l2/WindowBook.sol";
import {Order, PoolState, Side} from "../../src/types/Types.sol";
import {MockWETH} from "../l1/mocks/MockWETH.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPool} from "../mocks/MockPool.sol";
import {FrameManager} from "./mocks/Frame.sol";

/// @notice Phase 6, part A: both halves of the DEX, wired to each other.
/// @dev Every prior phase proved its own half against a stub of the other —
/// WP-2's suite returns a crafted `WindowResult` from a mock proxy, WP-1's
/// calls the router directly as the zone, WP-B's frame ends at a mock
/// counterpart. This fixture removes all three stubs at once and deploys what
/// a deployment deploys:
///
/// | L2 | L1 |
/// |---|---|
/// | `WindowBook` + `Mirror` | `SettlementRouter` + `UniswapV3Adapter` + `MockPool` |
/// | `DexBridgeL2` **[full]** | `DexBridge` **[full]** |
/// | `FrameManager` (zone) | `FrameManager` (mainnet) |
///
/// Two pair shapes, because the product has two. `ETHER_USDC` is
/// the launch pair: **A is ether** — zone ETH on L2, WETH on L1, carried as
/// the call's `value` in both directions — and **B is a 6-decimal USDC**,
/// which moves as a `DexBridge` reserve and an L2 representation **[full]**
/// or is delivered on L1 **[genesis]**. `TOKEN_TOKEN` is the
/// 18-decimal ERC-20 pair the TS-1 leg-parity fixture is written against, at
/// a zero-fee pool so the mirror and the venue agree exactly.
abstract contract FrameFixture is Test {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    uint64 internal constant L1_ROLLUP_ID = 0;
    uint64 internal constant ZONE_ROLLUP_ID = 1337;

    uint64 internal constant DEADLINE_SECONDS = 24;
    uint64 internal constant L1_CALL_GAS = 2_000_000;

    /// @dev The clock every fixture starts at, so a recorded deadline is a
    /// constant rather than today's date.
    uint64 internal constant START_TIME = 1_800_000_000;

    enum Pair {
        ETHER_USDC,
        TOKEN_TOKEN
    }

    // --- L1 ---
    FrameManager internal managerL1;
    MockWETH internal weth;
    MockPool internal pool;
    UniswapV3Adapter internal adapter;
    SettlementRouter internal router;
    DexBridge internal bridge;

    // --- L2 ---
    FrameManager internal managerL2;
    DexBridgeL2 internal bridgeL2;
    WindowBook internal book;

    // --- the pair ---
    Pair internal pairShape;
    Profile internal profile;
    /// @notice The pair's assets on L1: A is the one `SELL_A_FOR_B` sells.
    address internal l1AssetA;
    address internal l1AssetB;
    /// @notice The same pair on L2: the zero address is native zone ether.
    address internal assetA;
    address internal assetB;
    uint256 internal poolReserveA;
    uint256 internal poolReserveB;

    address internal bookOwner = makeAddr("owner");
    address internal settler = makeAddr("settler");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // ---------------------------------------------------------------- deployment ---

    function _deployFrame(Profile profile_) internal {
        _deployFrame(profile_, Pair.ETHER_USDC);
    }

    function _deployFrame(Profile profile_, Pair pair_) internal {
        profile = profile_;
        pairShape = pair_;

        managerL1 = new FrameManager(L1_ROLLUP_ID);
        managerL2 = new FrameManager(ZONE_ROLLUP_ID);
        managerL1.setPeer(managerL2);
        managerL2.setPeer(managerL1);

        uint24 fee = _deployPairTokens(pair_);
        pool = new MockPool(l1AssetA, l1AssetB, fee, _sqrtPriceFor(_price()), _liquidity());
        MockERC20(l1AssetA).mint(address(pool), poolReserveA * 1000);
        MockERC20(l1AssetB).mint(address(pool), poolReserveB * 1000);
        adapter = new UniswapV3Adapter(address(pool), l1AssetA);

        if (profile_ == Profile.FULL) _deployBridgePair(pair_);

        // Each half names the other, and neither address exists when the first
        // is constructed: the router is given the book's CREATE address.
        address predictedBook = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        router = new SettlementRouter(
            managerL1,
            ZONE_ROLLUP_ID,
            predictedBook,
            adapter,
            l1AssetA,
            l1AssetB,
            IWETH9(address(weth)),
            profile_ == Profile.FULL ? IDexBridge(address(bridge)) : IDexBridge(address(0))
        );
        book = new WindowBook(_config(), bookOwner, _poolState());
        assertEq(address(book), predictedBook, "fixture: the book did not land where the router was told");

        vm.warp(START_TIME);
    }

    /// @dev Deploys the pair's L1 tokens and returns the venue's fee tier. A
    /// v3 pool sorts its tokens by address and the price is read as `token1`
    /// per `token0`, so A is always deployed below B.
    function _deployPairTokens(Pair pair_) private returns (uint24 fee) {
        if (pair_ == Pair.ETHER_USDC) {
            MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
            weth = MockWETH(payable(_deployBelow(address(usdc), type(MockWETH).creationCode)));
            // The pool holds minted WETH rather than wrapped ether, so back
            // the wrapper with the ether an unwrap on the buy side asks for.
            vm.deal(address(weth), 1e27);
            (l1AssetA, l1AssetB) = (address(weth), address(usdc));
            (poolReserveA, poolReserveB) = (1000e18, 2_000_000e6);
            // The launch pair's real tier. The residual pays it, which is why
            // no limit in these suites sits exactly at the mirror price.
            return 500;
        }

        MockERC20 tokenB = new MockERC20("Beta", "B", 18);
        l1AssetA = _deployBelow(
            address(tokenB), abi.encodePacked(type(MockERC20).creationCode, abi.encode("Alpha", "A", uint8(18)))
        );
        l1AssetB = address(tokenB);
        (poolReserveA, poolReserveB) = (1000e18, 2_000_000e18);
        // Neither side of this pair is ether, but the router still takes a
        // wrapper: nothing in the leg reaches it.
        weth = new MockWETH();
        // A zero fee tier, so the venue's curve is exactly the one `Mirror`
        // models and the TS-1 leg-parity numbers hold end to end.
        return 0;
    }

    /// @dev Redeploys `creationCode` until its address sorts below `other`.
    function _deployBelow(address other, bytes memory creationCode) private returns (address found) {
        for (uint256 i = 0; i < 128; ++i) {
            assembly {
                found := create(0, add(creationCode, 0x20), mload(creationCode))
            }
            require(found != address(0), "fixture: deployment failed");
            if (found < other) return found;
        }
        revert("fixture: no address below the pair's B asset");
    }

    function _deployBridgePair(Pair pair_) private {
        bridge = DexBridge(
            address(
                new ERC1967Proxy(
                    address(new DexBridge()),
                    abi.encodeCall(
                        DexBridge.initialize,
                        (address(managerL1), ZONE_ROLLUP_ID, address(0), address(this), guardian, 1 hours)
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
                        (address(managerL2), L1_ROLLUP_ID, address(bridge), address(this), guardian)
                    )
                )
            )
        );
        bridge.setL2Bridge(address(bridgeL2));

        // Ether is the rail's own asset and never the bridge's (CT-5).
        if (pair_ != Pair.ETHER_USDC) assetA = _support(l1AssetA);
        assetB = _support(l1AssetB);
    }

    function _support(address l1Token) private returns (address l2Token) {
        bridge.setTokenSupport(l1Token, true, type(uint256).max);
        l2Token = bridgeL2.registerToken(
            l1Token,
            string.concat(MockERC20(l1Token).name(), " (eez)"),
            MockERC20(l1Token).symbol(),
            MockERC20(l1Token).decimals()
        );
    }

    function _config() private returns (BookConfig memory cfg) {
        // [genesis] there is no bridge and no L2 representation: A is zone
        // ether and B is only ever an L1 address (CT-4, FL-3).
        if (profile != Profile.FULL) assetB = l1AssetB;

        cfg = BookConfig({
            profile: profile,
            manager: address(managerL2),
            router: address(router),
            bridgeL2: profile == Profile.FULL ? address(bridgeL2) : address(0),
            assetA: assetA,
            assetB: assetB,
            l1AssetA: l1AssetA,
            l1AssetB: l1AssetB,
            feeMode: FeeMode.BPS,
            feeBps: 1, // EC-1's ceiling at measured gas
            feeFixedA: 0,
            feeFixedB: 0,
            routeFeeModel: RouteFeeModel.ABSORB, // EC-1's launch setting
            routeFeeWei: 0,
            windowSlots: 1,
            l1CallGas: L1_CALL_GAS,
            settler: settler
        });
    }

    // ------------------------------------------------------------------- prices ---

    /// @notice The pair's opening price: B per A in Q96, in the raw units both
    /// chains count in (A.1).
    function _price() internal view returns (uint256) {
        return Math.mulDiv(poolReserveB, Q96, poolReserveA);
    }

    function _sqrtPriceFor(uint256 priceX96) internal pure returns (uint160) {
        // casting to 'uint160' is safe because the pair's price is far inside the v3 domain
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(priceX96 * Q96));
    }

    function _liquidity() internal view returns (uint128) {
        // casting to 'uint128' is safe because this pool's liquidity is at most ~4.5e22
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(Math.sqrt(poolReserveA * poolReserveB));
    }

    function _poolState() internal view returns (PoolState memory) {
        return PoolState({sqrtPriceX96: _sqrtPriceFor(_price()), liquidity: _liquidity(), tick: 0});
    }

    /// @notice The L1 pool's spot, as the router reads it: B per A in Q96.
    function _spotPriceX96() internal view returns (uint256) {
        uint160 sqrtPriceX96 = pool.sqrtPriceX96();
        return Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
    }

    /// @notice Moves the L1 pool under the open window — the HX-3 `drift` op.
    function _driftL1(uint256 priceX96) internal {
        pool.setSqrtPriceX96(_sqrtPriceFor(priceX96));
    }

    // ------------------------------------------------------------------- orders ---

    function _order(
        address owner_,
        Side side,
        uint256 sellAmount,
        uint256 minBuyAmount
    )
        internal
        pure
        returns (Order memory o)
    {
        o = Order({
            id: bytes32(0),
            owner: owner_,
            side: side,
            sellAmount: sellAmount,
            minBuyAmount: minBuyAmount,
            recipient: owner_,
            expiresAfter: 4
        });
    }

    /// @notice Places an order, funding its sell side the way the profile
    /// funds it: native zone ether as `value`, or an L2 representation the
    /// bridge minted against a locked L1 reserve (CT-5, CT-7).
    function _place(address who, Side side, uint256 sellAmount, uint256 minBuyAmount) internal returns (bytes32 id) {
        address sellAsset = side == Side.SELL_A_FOR_B ? assetA : assetB;
        if (sellAsset == address(0)) {
            vm.deal(who, who.balance + sellAmount);
            vm.prank(who);
            return book.place{value: sellAmount}(_order(who, side, sellAmount, minBuyAmount));
        }

        _bridgeIn(side == Side.SELL_A_FOR_B ? l1AssetA : l1AssetB, who, sellAmount);
        vm.prank(who);
        IERC20(sellAsset).approve(address(book), sellAmount);
        vm.prank(who);
        id = book.place(_order(who, side, sellAmount, minBuyAmount));
    }

    /// @notice The inbound leg, driven as anyone would drive it: lock the L1
    /// token and credit its L2 representation to `to`.
    function _bridgeIn(address l1Token, address to, uint256 amount) internal {
        MockERC20(l1Token).mint(address(this), amount);
        MockERC20(l1Token).transfer(address(bridge), amount);
        Credit[] memory credits = new Credit[](1);
        credits[0] = Credit({recipient: to, amount: amount});
        bridge.deposit(l1Token, amount, credits);
    }

    function _settle(bytes32[] memory ids) internal {
        vm.prank(settler);
        book.settleWindow(ids, uint64(block.timestamp) + DEADLINE_SECONDS);
    }

    function _ids(bytes32 a) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = a;
    }

    function _ids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](2);
        ids[0] = a;
        ids[1] = b;
    }

    /// @notice An L2 balance of the pair's asset, native or ERC-20.
    function _balance(address asset, address owner_) internal view returns (uint256) {
        return book.balanceOf(asset, owner_);
    }

    // --------------------------------------------------------------- invariants ---

    /// @notice CT-13, per asset, to the wei.
    function _assertEscrowInvariant() internal view {
        assertEq(book.escrowInvariantDrift(assetA), 0, "CT-13: the A escrow invariant drifted");
        assertEq(book.escrowInvariantDrift(assetB), 0, "CT-13: the B escrow invariant drifted");
    }

    /// @notice **[full]** EC-4's custody invariant: every L1 reserve backs an
    /// L2 representation one for one, per token.
    function _assertReserveInvariant() internal view {
        _assertReserveInvariant(l1AssetB);
        if (assetA != address(0)) _assertReserveInvariant(l1AssetA);
    }

    function _assertReserveInvariant(address l1Token) internal view {
        assertEq(
            bridge.locked(l1Token),
            IERC20(bridgeL2.l2TokenFor(l1Token)).totalSupply(),
            "EC-4: the locked reserve does not equal the L2 supply it backs"
        );
    }

    function _feeBps(uint256 amount) internal pure returns (uint256) {
        return amount / 10_000;
    }
}
