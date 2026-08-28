// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {WindowBook} from "../../src/l2/WindowBook.sol";
import {Order, PoolState, Side} from "../../src/types/Types.sol";
import {MockZoneProxy} from "./mocks/MockZone.sol";
import {WindowBookFixture} from "./WindowBookFixture.sol";

/// @notice Drives the book the way a live window does: orders arrive on both sides,
/// some are cancelled, the L1 pool drifts underneath, the settler settles a subset it
/// chose, balances are withdrawn, expired escrow is reclaimed.
/// @dev Every call is allowed to revert (`fail_on_revert = false`): a settlement the
/// price band rejects is a *correct* outcome, and the point of the invariant is that
/// neither the successes nor the failures move value outside CT-13.
contract WindowBookHandler is Test {
    uint256 private constant Q96 = 0x1000000000000000000000000;

    WindowBook private immutable BOOK;
    MockZoneProxy private immutable PROXY;
    MockERC20 private immutable TOKEN_A;
    MockERC20 private immutable TOKEN_B;
    address private immutable SETTLER;

    address[4] private actors;
    bytes32[] private placed;

    constructor(
        WindowBook book_,
        MockZoneProxy proxy_,
        MockERC20 tokenA_,
        MockERC20 tokenB_,
        address settler_,
        address[4] memory actors_
    ) {
        BOOK = book_;
        PROXY = proxy_;
        TOKEN_A = tokenA_;
        TOKEN_B = tokenB_;
        SETTLER = settler_;
        actors = actors_;
    }

    function placeOrder(uint256 actorSeed, uint256 amountSeed, uint256 limitSeed, bool sellA) external {
        address actor = actors[actorSeed % actors.length];
        Side side = sellA ? Side.SELL_A_FOR_B : Side.SELL_B_FOR_A;
        MockERC20 token = sellA ? TOKEN_A : TOKEN_B;
        uint256 sellAmount = sellA ? bound(amountSeed, 1e14, 20e18) : bound(amountSeed, 1e14, 40_000e18);

        // A limit somewhere between hopeless and generous, so some windows settle and
        // some are rejected by the band.
        uint256 atSpot = sellA ? (sellAmount * 2000) : (sellAmount / 2000);
        uint256 minBuyAmount = (atSpot * bound(limitSeed, 80, 105)) / 100;

        token.mint(actor, sellAmount);
        vm.startPrank(actor);
        token.approve(address(BOOK), type(uint256).max);
        bytes32 id = BOOK.place(
            Order({
                id: bytes32(0),
                owner: actor,
                side: side,
                sellAmount: sellAmount,
                minBuyAmount: minBuyAmount,
                recipient: actor,
                expiresAfter: uint32(bound(limitSeed, 0, 3))
            })
        );
        vm.stopPrank();
        placed.push(id);
    }

    function cancelOrder(uint256 seed) external {
        bytes32 id = _pick(seed);
        if (id == bytes32(0)) return;
        vm.prank(BOOK.orderOf(id).owner);
        BOOK.cancel(id);
    }

    function reclaimOrder(uint256 seed) external {
        bytes32 id = _pick(seed);
        if (id == bytes32(0)) return;
        BOOK.reclaim(id);
    }

    function withdrawBalance(uint256 actorSeed, uint256 amountSeed, bool assetA) external {
        address actor = actors[actorSeed % actors.length];
        address asset = assetA ? address(TOKEN_A) : address(TOKEN_B);
        uint256 balance = BOOK.balanceOf(asset, actor);
        if (balance == 0) return;
        vm.prank(actor);
        BOOK.withdraw(asset, bound(amountSeed, 1, balance));
    }

    /// @dev The settler's selection: every open order whose index passes a coin flip,
    /// which is as adversarial as FL-8 allows — the contract rebuilds the leg regardless.
    function settleWindow(uint256 seed) external {
        bytes32[] memory open = BOOK.openOrderIds();
        if (open.length == 0) return;

        uint256 count;
        bytes32[] memory selection = new bytes32[](open.length);
        for (uint256 i = 0; i < open.length; ++i) {
            if ((seed >> (i % 250)) & 1 == 1) selection[count++] = open[i];
        }
        if (count == 0) return;

        bytes32[] memory ids = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = selection[i];
        }

        vm.prank(SETTLER);
        BOOK.settleWindow(ids, uint64(block.timestamp + 24));
    }

    /// @dev The HX-3 `drift` op: the mainnet pool moves under the window.
    function driftPool(uint256 seed) external {
        uint256 priceX96 = bound(seed, 1600, 2400) * Q96;
        PROXY.setPoolState(_poolAt(priceX96));
    }

    function _pick(uint256 seed) private view returns (bytes32) {
        if (placed.length == 0) return bytes32(0);
        return placed[seed % placed.length];
    }

    function _poolAt(uint256 priceX96) private pure returns (PoolState memory) {
        // casting is safe because these prices and this liquidity are the fixture pool's
        // forge-lint: disable-next-line(unsafe-typecast)
        return PoolState({
            sqrtPriceX96: uint160(Math.sqrt(priceX96 * Q96)),
            liquidity: uint128(Math.sqrt(1000e18 * 2_000_000e18)),
            tick: 0
        });
    }
}

/// @notice TS-1 — the per-asset escrow invariant as a Foundry `invariant_` test (CT-13).
/// @dev `Σ open escrow + Σ fees + Σ dust + Σ L2 balances == Σ deposits − Σ released −
/// Σ withdrawn`, per asset, at every state the handler can reach. This is the assertion
/// the acceptance criteria call "holds to the wei after every scenario and the 200-slot
/// soak" (RD-2 §10); WP-4 asserts the same numbers against the enclave.
contract WindowBookInvariantTest is WindowBookFixture {
    WindowBookHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new WindowBookHandler(book, proxy, tokenA, tokenB, settler, [alice, bob, carol, dave]);
        targetContract(address(handler));
    }

    function invariant_escrow_holds_per_asset() public view {
        assertEq(book.escrowInvariantDrift(address(tokenA)), 0, "CT-13: asset A");
        assertEq(book.escrowInvariantDrift(address(tokenB)), 0, "CT-13: asset B");
        assertEq(book.escrowInvariantDrift(address(0)), 0, "CT-13: ETH");
    }

    /// @dev The ledger is not merely self-consistent: the book holds what it owes.
    function invariant_escrow_is_backed_by_real_holdings() public view {
        _assertHoldingsCover(address(tokenA));
        _assertHoldingsCover(address(tokenB));
    }
}
