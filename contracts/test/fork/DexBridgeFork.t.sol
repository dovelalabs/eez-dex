// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BridgeFixture} from "../bridge/BridgeFixture.sol";
import {IUniswapV3PoolMinimal, MinimalPoolRouter} from "../bridge/mocks/MinimalPoolRouter.sol";

/// @title TS-B — the mainnet-fork round trip (WP-B, CT-5, CT-11).
/// @notice A whole `release` -> swap -> `deposit` frame against the real
/// Uniswap v3 USDC/WETH pool at a pinned block: the sell side leaves the
/// reserve, the pool prices it, and the bought asset comes back as an L2
/// credit — with the reserve invariant intact at every step.
///
/// @dev Needs a real RPC and runs sequentially, so it lives in the fork suite
/// `contracts/foundry.toml` pins the `fork` profile to — `test/fork/**` — which
/// the default profile excludes, so `make check` never reaches it. Without an
/// `ETH_RPC` every case skips rather than failing on the network.
///
///   make contracts-fork
///   FOUNDRY_PROFILE=fork forge test --match-path 'test/fork/*Fork*' -vv
contract DexBridgeForkTest is BridgeFixture {
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// @notice Uniswap v3 USDC/WETH, 0.05% tier — the deepest ETH pool, and
    /// EC-5's density baseline pair.
    address internal constant POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;

    /// @notice The pinned block. Overridable with `FORK_BLOCK` so a rerun can
    /// be pinned elsewhere; recorded numbers are only comparable at one block.
    uint256 internal constant DEFAULT_FORK_BLOCK = 25_800_000;

    uint256 internal constant WETH_RESERVE = 100 ether;
    uint256 internal constant WETH_LEG = 10 ether;

    bool internal forkActive;

    MinimalPoolRouter internal router;
    address internal user = makeAddr("user");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        string memory pinned = vm.envOr("FORK_BLOCK", string(""));
        vm.createSelectFork(rpc, bytes(pinned).length == 0 ? DEFAULT_FORK_BLOCK : vm.parseUint(pinned));
        forkActive = true;

        _deployBridgePair();
        _registerToken(WETH, "eez Wrapped Ether", "eezWETH", 18, 1_000 ether);
        _registerToken(USDC, "eez USD Coin", "eezUSDC", 6, 10_000_000e6);

        router = new MinimalPoolRouter(bridge, IUniswapV3PoolMinimal(POOL));

        deal(WETH, address(this), WETH_RESERVE);
        _depositTo(WETH, user, WETH_RESERVE);
    }

    modifier onlyFork() {
        if (!forkActive) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @notice WETH out of the reserve, through the real pool, USDC back in as
    /// an L2 credit — one round trip of the full form's ERC-20 leg.
    function test_tsb_fork_release_swap_deposit_round_trips_weth_for_usdc() public onlyFork {
        vm.prank(user);
        bridgeL2.releaseTo(WETH, user, WETH_LEG, address(router));
        assertEq(IERC20(WETH).balanceOf(address(router)), WETH_LEG, "the router holds the sell side");

        (address tokenOut, uint256 amountOut) = router.swapAndDeposit(WETH, WETH_LEG, user);

        assertEq(tokenOut, USDC, "the pool paid out USDC");
        assertGt(amountOut, 0, "the swap produced output");
        assertEq(IERC20(bridgeL2.l2TokenFor(USDC)).balanceOf(user), amountOut, "credited to the L2 recipient");
        assertEq(IERC20(bridgeL2.l2TokenFor(WETH)).balanceOf(user), WETH_RESERVE - WETH_LEG, "sell side burned");

        _assertReserveInvariant();
    }

    /// @notice And back the other way, so both sides of the pair are exercised
    /// against the real pool.
    function test_tsb_fork_release_swap_deposit_round_trips_usdc_for_weth() public onlyFork {
        vm.prank(user);
        bridgeL2.releaseTo(WETH, user, WETH_LEG, address(router));
        (, uint256 usdcOut) = router.swapAndDeposit(WETH, WETH_LEG, user);
        _assertReserveInvariant();

        uint256 wethBefore = IERC20(bridgeL2.l2TokenFor(WETH)).balanceOf(user);

        vm.prank(user);
        bridgeL2.releaseTo(USDC, user, usdcOut, address(router));
        (address tokenOut, uint256 wethOut) = router.swapAndDeposit(USDC, usdcOut, user);

        assertEq(tokenOut, WETH, "the pool paid out WETH");
        assertGt(wethOut, 0, "the return leg produced output");
        assertEq(IERC20(bridgeL2.l2TokenFor(USDC)).balanceOf(user), 0, "the USDC leg was fully sold");
        assertEq(IERC20(bridgeL2.l2TokenFor(WETH)).balanceOf(user), wethBefore + wethOut, "WETH credited back");

        _assertReserveInvariant();
    }

    /// @notice The failure row Phase 4a drives in the enclave, pinned here
    /// against real tokens: a reserve short of the residual reverts the frame,
    /// so no swap happens and nothing is burned (CT-5, HX-3).
    function test_tsb_fork_short_reserve_reverts_the_whole_frame() public onlyFork {
        vm.prank(user);
        vm.expectRevert();
        bridgeL2.releaseTo(WETH, user, WETH_RESERVE + 1, address(router));

        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "no sell side left the reserve");
        assertEq(IERC20(bridgeL2.l2TokenFor(WETH)).balanceOf(user), WETH_RESERVE, "nothing burned");
        _assertReserveInvariant();
    }

    function _assertReserveInvariant() private view {
        assertEq(bridge.locked(WETH), _l2Supply(WETH), "WETH reserve equals its L2 supply");
        assertEq(bridge.locked(USDC), _l2Supply(USDC), "USDC reserve equals its L2 supply");
        assertGe(IERC20(WETH).balanceOf(address(bridge)), bridge.locked(WETH), "WETH reserve is really held");
        assertGe(IERC20(USDC).balanceOf(address(bridge)), bridge.locked(USDC), "USDC reserve is really held");
    }
}
