// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {Order, PoolState, Side} from "../../src/types/Types.sol";
import {BookConfig, FeeMode, Profile, RouteFeeModel, WindowBook} from "../../src/l2/WindowBook.sol";
import {MockDexBridgeL2, MockEEZManager, MockZoneProxy} from "./mocks/MockZone.sol";

/// @notice The shared WP-2 test rig: a pair, a mirror, a registry, a zone proxy and a
/// book wired together the way a deployment wires them.
/// @dev Every suite below builds on this so a scenario reads as orders and prices rather
/// than as setup. The default is the **full** form with an 18-decimal ERC-20 pair; the
/// helpers switch profile, fee shape and ETH leg without a second code path, because
/// that is what "profile is configuration, never a fork" has to mean in the tests too.
abstract contract WindowBookFixture is Test {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice The launch pair's opening price: 2000 B per A.
    uint256 internal constant PRICE_X96 = 2000 * Q96;

    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    MockEEZManager internal manager;
    MockZoneProxy internal proxy;
    MockDexBridgeL2 internal bridgeL2;
    WindowBook internal book;

    address internal bookOwner = makeAddr("owner");
    address internal settler = makeAddr("settler");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    address internal constant L1_TOKEN_A = address(0xA11);
    address internal constant L1_TOKEN_B = address(0xB22);
    address internal constant ROUTER_L1 = address(0x9017);

    // ------------------------------------------------------------------- set-up ---

    function _defaultConfig() internal view returns (BookConfig memory cfg) {
        cfg = BookConfig({
            profile: Profile.FULL,
            manager: address(manager),
            router: ROUTER_L1,
            bridgeL2: address(bridgeL2),
            assetA: address(tokenA),
            assetB: address(tokenB),
            l1AssetA: L1_TOKEN_A,
            l1AssetB: L1_TOKEN_B,
            feeMode: FeeMode.BPS,
            feeBps: 1, // EC-1's launch ceiling at 2026 gas
            feeFixedA: 0,
            feeFixedB: 0,
            routeFeeModel: RouteFeeModel.ABSORB, // EC-1's launch setting
            routeFeeWei: 0,
            windowSlots: 1,
            l1CallGas: 2_000_000,
            settler: settler
        });
    }

    /// @dev Deploys the pair, the registry, the proxy and the book, and seeds the mirror
    /// and the proxy's pool with the same state — the steady state a settlement leaves.
    function _deploy(BookConfig memory cfg) internal {
        PoolState memory state = _poolState(PRICE_X96);
        book = new WindowBook(cfg, bookOwner, state);

        bridgeL2.map(cfg.l1AssetA, cfg.assetA);
        bridgeL2.map(cfg.l1AssetB, cfg.assetB);
        manager.register(cfg.router, 0, address(proxy));
        proxy.configure(address(book), cfg.assetA, cfg.assetB, cfg.profile == Profile.FULL);
        proxy.setPoolState(state);

        // The frame delivers the bought asset from L1; give it something to deliver.
        tokenA.mint(address(proxy), 1e30);
        tokenB.mint(address(proxy), 1e30);
        vm.deal(address(proxy), 1e24);
    }

    function setUp() public virtual {
        tokenA = new MockERC20("Asset A", "A", 18);
        tokenB = new MockERC20("Asset B", "B", 18);
        manager = new MockEEZManager();
        proxy = new MockZoneProxy();
        bridgeL2 = new MockDexBridgeL2();
        _deploy(_defaultConfig());
    }

    // ------------------------------------------------------------------ helpers ---

    /// @dev `sqrtPriceX96` for a Q96 price, so a test states 2000 B per A and not a
    /// 160-bit square root.
    function _sqrtPriceFor(uint256 priceX96) internal pure returns (uint160) {
        // casting to 'uint160' is safe because prices used here are far inside the v3
        // domain
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(priceX96 * Q96));
    }

    /// @dev A pool of 1000 A and 2,000,000 B at `priceX96` — deep enough that a window's
    /// residual moves it by basis points, which is the regime EC-5 measures.
    function _poolState(uint256 priceX96) internal pure returns (PoolState memory) {
        // casting to 'uint128' is safe because the liquidity of this fixture pool is
        // ~4.5e22
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidity = uint128(Math.sqrt(1000e18 * 2_000_000e18));
        return PoolState({sqrtPriceX96: _sqrtPriceFor(priceX96), liquidity: liquidity, tick: 0});
    }

    /// @dev Moves the L1 pool under the window — the HX-3 `drift` op, in a unit test.
    function _driftL1(uint256 priceX96) internal {
        proxy.setPoolState(_poolState(priceX96));
    }

    function _fund(address who, MockERC20 token, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(book), type(uint256).max);
    }

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

    /// @dev Places an ERC-20 order, funding and approving first.
    function _place(address who, Side side, uint256 sellAmount, uint256 minBuyAmount) internal returns (bytes32 id) {
        MockERC20 sellToken = side == Side.SELL_A_FOR_B ? tokenA : tokenB;
        _fund(who, sellToken, sellAmount);
        vm.prank(who);
        id = book.place(_order(who, side, sellAmount, minBuyAmount));
    }

    /// @dev Places an order with an explicit expiry, in windows (CT-7).
    function _placeExpiring(
        address who,
        Side side,
        uint256 sellAmount,
        uint256 minBuyAmount,
        uint32 expiresAfter
    )
        internal
        returns (bytes32 id)
    {
        MockERC20 sellToken = side == Side.SELL_A_FOR_B ? tokenA : tokenB;
        _fund(who, sellToken, sellAmount);
        Order memory o = _order(who, side, sellAmount, minBuyAmount);
        o.expiresAfter = expiresAfter;
        vm.prank(who);
        id = book.place(o);
    }

    /// @dev Places an order whose sell asset is native zone ETH (FL-3 [genesis]).
    function _placeEth(address who, Side side, uint256 sellAmount, uint256 minBuyAmount) internal returns (bytes32 id) {
        vm.deal(who, who.balance + sellAmount);
        vm.prank(who);
        id = book.place{value: sellAmount}(_order(who, side, sellAmount, minBuyAmount));
    }

    function _settle(bytes32[] memory ids) internal {
        vm.prank(settler);
        book.settleWindow(ids, uint64(block.timestamp + 24));
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

    function _ids(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }

    /// @notice CT-13, per asset, to the wei — the assertion every scenario ends with.
    function _assertEscrowInvariant() internal view {
        assertEq(book.escrowInvariantDrift(address(tokenA)), 0, "CT-13: asset A escrow invariant drifted");
        assertEq(book.escrowInvariantDrift(address(tokenB)), 0, "CT-13: asset B escrow invariant drifted");
        assertEq(book.escrowInvariantDrift(address(0)), 0, "CT-13: ETH escrow invariant drifted");
    }

    /// @notice The ledger is not just self-consistent: the book actually holds it.
    function _assertHoldingsCover(address asset) internal view {
        uint256 held = asset == address(0) ? address(book).balance : MockERC20(asset).balanceOf(address(book));
        uint256 owed = book.escrowed(asset) + book.feesAccrued(asset) + book.dustAccrued(asset) + book.credited(asset);
        assertGe(held, owed, "book holds less than its ledger owes");
    }
}
