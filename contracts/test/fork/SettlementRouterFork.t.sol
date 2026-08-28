// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {console2} from "forge-std/console2.sol";
import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IDexBridge} from "../../src/interfaces/IDexBridge.sol";
import {IUniswapV3Pool} from "../../src/l1/adapters/IUniswapV3Pool.sol";
import {UniswapV3Adapter} from "../../src/l1/adapters/UniswapV3Adapter.sol";
import {IWETH9} from "../../src/l1/interfaces/IWETH9.sol";
import {Allocation, SettlementRouter} from "../../src/l1/SettlementRouter.sol";
import {Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";
import {MockDexBridge} from "../l1/mocks/MockDexBridge.sol";
import {MockEEZ} from "../l1/mocks/MockEEZ.sol";

/// @notice TS-2 — the L1 leg against **real Uniswap v3 pools** at a pinned
/// block, entered the way the framework enters it (`vm.prank(zoneProxy)`).
///
/// Two pools, one per pair family in RD-2's test row: WETH/USDC (0.05%, a
/// six-decimal quote asset) and wstETH/WETH (0.01%). Both leg shapes are
/// covered — the genesis form's value-in / L1-distribution and the full form's
/// bridge-released ERC-20 in / native value out (§10 acceptance).
///
/// The block is pinned so the gas recorded here is reproducible: those numbers
/// are what EC-1's fee ceiling is derived from, and they go in the PR body.
///
/// Not part of `make check`: `foundry.toml` excludes `test/fork/**` from the
/// default profile because this suite needs a real RPC and runs sequentially.
///
/// Run it with:
///
///     FOUNDRY_PROFILE=fork forge test --match-path 'test/fork/**' \
///         --no-match-path 'test/l1/**' -vv
///
/// The trailing exclusion is a workaround, not a preference: the frozen
/// `foundry.toml` sets `[profile.fork] no_match_path = ""`, and an empty glob
/// matches every path, so the profile as pinned discovers no tests at all —
/// which also makes `make contracts-fork` a silent no-op. Both files are
/// frozen at the scaffold, so WP-1 raises it rather than editing them
/// (README "frozen contracts", RD-2 RL-2).
contract SettlementRouterForkTest is Test {
    uint256 internal constant Q96 = 1 << 96;

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    /// @dev USDC/WETH 0.05%: `token0` is USDC, so A (WETH) is `token1`.
    address internal constant USDC_WETH_POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    /// @dev wstETH/WETH 0.01%: `token0` is wstETH, so A (WETH) is `token1`.
    address internal constant WSTETH_WETH_POOL = 0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa;

    /// @dev The pin. Override with FORK_BLOCK to re-measure at another block —
    /// and then say which block the numbers came from.
    uint256 internal constant DEFAULT_FORK_BLOCK = 25_821_280;

    uint64 internal constant ZONE_ROLLUP_ID = 7;
    address internal constant WINDOW_BOOK = address(0xB00C);
    address internal constant ZONE_PROXY = address(0x20E9);
    address internal constant ALICE = address(0xA11CE);

    uint64 internal deadline;
    uint256 internal forkBlock;
    MockEEZ internal eez;

    function setUp() public {
        forkBlock = vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK);
        vm.createSelectFork(vm.envOr("ETH_RPC", string("https://eth.drpc.org")), forkBlock);

        eez = new MockEEZ();
        eez.setProxy(WINDOW_BOOK, ZONE_ROLLUP_ID, ZONE_PROXY);
        deadline = uint64(block.timestamp + 24); // DEADLINE_SECONDS (A.5)
    }

    // --- the genesis leg shape ----------------------------------------------------

    function test_ts2_genesis_settles_eth_for_usdc_against_the_real_pool() public {
        _assertGenesisLegSettles(USDC_WETH_POOL, USDC, 1 ether);
    }

    function test_ts2_genesis_settles_eth_for_wsteth_against_the_real_pool() public {
        _assertGenesisLegSettles(WSTETH_WETH_POOL, WSTETH, 10 ether);
    }

    /// @dev Runs one genesis leg and holds it to CT-1, CT-2 and CT-4: `P0` is
    /// the pool's own pre-trade spot, the realised price is the swap's, the
    /// returned state is the pool's actual post-trade state, and the recipient
    /// is paid on L1 in the same call.
    function _assertGenesisLegSettles(address poolAddress, address quoteToken, uint256 residualIn) internal {
        (SettlementRouter router,) = _genesisVenue(poolAddress, quoteToken);

        uint256 spot = _spotPriceX96(poolAddress);
        WindowLeg[] memory legs = _legs(
            WindowLeg({
                windowId: 1,
                residualSide: Side.SELL_A_FOR_B,
                residualIn: residualIn,
                minPriceX96: (spot * 9900) / 10_000,
                maxPriceX96: (spot * 10_100) / 10_000,
                deadline: deadline,
                distribution: _distribution(_one(ALICE), _one(residualIn))
            })
        );

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: residualIn}(legs);
        WindowResult memory r = results[0];

        assertEq(r.amountIn, residualIn, "amountIn is the residual");
        assertGt(r.amountOut, 0, "the real pool filled it");
        assertEq(r.referencePriceX96, spot, "P0 is the pool's pre-trade spot, B per A");
        assertEq(r.executionPriceX96, Math.mulDiv(r.amountOut, Q96, r.amountIn), "realised average, B per A");
        assertLt(r.executionPriceX96, r.referencePriceX96, "the residual bears fee and impact");
        assertEq(r.l1Block, uint64(block.number), "the L1 block");

        // The return value becomes the next mirror, so it must be the pool's
        // real state, not an estimate (FL-1, CT-2).
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(poolAddress).slot0();
        assertEq(r.post.sqrtPriceX96, sqrtPriceX96, "post sqrt price equals the pool's");
        assertEq(r.post.liquidity, IUniswapV3Pool(poolAddress).liquidity(), "post liquidity equals the pool's");
        assertEq(r.post.tick, tick, "post tick equals the pool's");

        assertEq(IERC20(quoteToken).balanceOf(ALICE), r.amountOut, "paid on L1 inside the same call");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "the sell side was fully swapped");
    }

    /// @notice Every genesis order is residual-side: the leg's `residualIn` is
    /// the gross of the window, not a net of it (FL-4 is vacuous, FL-5).
    function test_ts2_genesis_leg_shows_zero_crossing() public {
        (SettlementRouter router,) = _genesisVenue(USDC_WETH_POOL, USDC);

        address[] memory recipients = new address[](8);
        uint256[] memory sellAmounts = new uint256[](8);
        uint256 gross;
        for (uint256 i = 0; i < 8; ++i) {
            recipients[i] = address(uint160(0xA11CE00 + i));
            sellAmounts[i] = (i + 1) * 0.1 ether;
            gross += sellAmounts[i];
        }

        uint256 spot = _spotPriceX96(USDC_WETH_POOL);
        WindowLeg[] memory legs = _legs(
            WindowLeg({
                windowId: 1,
                residualSide: Side.SELL_A_FOR_B,
                residualIn: gross, // the residual IS the gross: nothing crossed
                minPriceX96: (spot * 9900) / 10_000,
                maxPriceX96: (spot * 10_100) / 10_000,
                deadline: deadline,
                distribution: _distribution(recipients, sellAmounts)
            })
        );

        vm.deal(ZONE_PROXY, gross);
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle{value: gross}(legs);

        assertEq(results[0].amountIn, gross, "the whole window went to the pool: zero crossing");
        uint256 paid;
        for (uint256 i = 0; i < 8; ++i) {
            uint256 expected = Math.mulDiv(sellAmounts[i], results[0].amountOut, gross);
            assertEq(IERC20(USDC).balanceOf(recipients[i]), expected, "every order fills at the realised price");
            paid += expected;
        }
        assertLe(paid, results[0].amountOut, "sum of outputs never exceeds the leg's output");
        assertEq(IERC20(USDC).balanceOf(address(router)), results[0].amountOut - paid, "dust stays with the protocol");
    }

    // --- CT-6 · the mirror refresh ------------------------------------------------

    function test_ts2_empty_settlement_returns_the_pools_current_state() public {
        (SettlementRouter router,) = _genesisVenue(USDC_WETH_POOL, USDC);
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(USDC_WETH_POOL).slot0();

        WindowLeg[] memory legs = _legs(
            WindowLeg({
                windowId: 1,
                residualSide: Side.SELL_A_FOR_B,
                residualIn: 0,
                minPriceX96: 0,
                maxPriceX96: type(uint256).max,
                deadline: deadline,
                distribution: ""
            })
        );

        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        assertEq(results[0].amountIn, 0, "no swap");
        assertEq(results[0].referencePriceX96, _spotPriceX96(USDC_WETH_POOL), "the current spot");
        assertEq(results[0].post.sqrtPriceX96, sqrtPriceX96, "the pool is untouched");
        assertEq(results[0].post.liquidity, IUniswapV3Pool(USDC_WETH_POOL).liquidity(), "and so is its liquidity");
        assertEq(results[0].post.tick, tick, "and its tick");
    }

    // --- the full leg shape --------------------------------------------------------

    /// @notice [full] The sell side was released into the router by
    /// `DexBridge` earlier in this frame; the ETH buy side leaves by the
    /// protocol's native value path (CT-5).
    function test_ts2_full_form_settles_usdc_for_eth_against_the_real_pool() public {
        MockDexBridge dexBridge = new MockDexBridge();
        (SettlementRouter router,) = _venue(USDC_WETH_POOL, USDC, dexBridge);

        uint256 residualIn = 4_000e6; // USDC, six decimals
        deal(USDC, address(dexBridge), residualIn);
        dexBridge.release(USDC, residualIn, address(router));

        uint256 spot = _spotPriceX96(USDC_WETH_POOL);
        WindowLeg[] memory legs = _legs(
            WindowLeg({
                windowId: 1,
                residualSide: Side.SELL_B_FOR_A,
                residualIn: residualIn,
                minPriceX96: (spot * 9900) / 10_000,
                maxPriceX96: (spot * 10_100) / 10_000,
                deadline: deadline,
                distribution: ""
            })
        );

        uint256 zoneBefore = ZONE_PROXY.balance;
        vm.prank(ZONE_PROXY);
        WindowResult[] memory results = router.settle(legs);

        assertGt(results[0].amountOut, 0, "the real pool filled it");
        assertGt(results[0].executionPriceX96, results[0].referencePriceX96, "selling B pays more B per A");
        assertEq(ZONE_PROXY.balance - zoneBefore, results[0].amountOut, "delivered as value to the zone");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "nothing left wrapped");
    }

    // --- EC-1 · the numbers the fee ceiling is derived from ------------------------

    /// @notice Records L1 gas per residual size at the pinned block. These are
    /// the numbers EC-1's fee ceiling is measured against, and the PR carries
    /// them (`.claude/rules/pull-requests.md`).
    function test_ts2_records_gas_per_residual_size() public {
        uint256[] memory sizes = new uint256[](5);
        sizes[0] = 0; // CT-6 refresh, no swap
        sizes[1] = 0.1 ether;
        sizes[2] = 1 ether;
        sizes[3] = 10 ether;
        sizes[4] = 100 ether;

        console2.log("SettlementRouter.settle gas, WETH/USDC 0.05%, block:", forkBlock);
        for (uint256 i = 0; i < sizes.length; ++i) {
            console2.log("  residual (wei):", sizes[i], " gas:", _measureGas(USDC_WETH_POOL, USDC, sizes[i]));
        }

        console2.log("SettlementRouter.settle gas, wstETH/WETH 0.01%, block:", forkBlock);
        for (uint256 i = 0; i < sizes.length; ++i) {
            console2.log("  residual (wei):", sizes[i], " gas:", _measureGas(WSTETH_WETH_POOL, WSTETH, sizes[i]));
        }
    }

    function _measureGas(address poolAddress, address quoteToken, uint256 residualIn) internal returns (uint256) {
        uint256 snapshot = vm.snapshotState();
        (SettlementRouter router,) = _genesisVenue(poolAddress, quoteToken);

        uint256 spot = _spotPriceX96(poolAddress);
        WindowLeg[] memory legs = _legs(
            WindowLeg({
                windowId: 1,
                residualSide: Side.SELL_A_FOR_B,
                residualIn: residualIn,
                minPriceX96: (spot * 9000) / 10_000,
                maxPriceX96: (spot * 11_000) / 10_000,
                deadline: deadline,
                distribution: residualIn == 0 ? bytes("") : _distribution(_one(ALICE), _one(residualIn))
            })
        );

        vm.deal(ZONE_PROXY, residualIn);
        vm.prank(ZONE_PROXY);
        uint256 before = gasleft();
        router.settle{value: residualIn}(legs);
        uint256 used = before - gasleft();

        vm.revertToState(snapshot);
        return used;
    }

    // --- wiring --------------------------------------------------------------------

    function _genesisVenue(
        address poolAddress,
        address quoteToken
    )
        internal
        returns (SettlementRouter router, UniswapV3Adapter adapter)
    {
        return _venue(poolAddress, quoteToken, IDexBridge(address(0)));
    }

    /// @dev A (the asset sold as zone ETH) is always WETH; B is the pool's
    /// other token. The adapter reads the pool's own ordering.
    function _venue(
        address poolAddress,
        address quoteToken,
        IDexBridge bridge
    )
        internal
        returns (SettlementRouter router, UniswapV3Adapter adapter)
    {
        adapter = new UniswapV3Adapter(poolAddress, WETH);
        router = new SettlementRouter(eez, ZONE_ROLLUP_ID, WINDOW_BOOK, adapter, WETH, quoteToken, IWETH9(WETH), bridge);
    }

    /// @dev B per A in Q96 from the pool's sorted-order sqrt price. A is WETH,
    /// which is `token1` in both pools here.
    function _spotPriceX96(address poolAddress) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(poolAddress).slot0();
        uint256 token1PerToken0 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
        bool aIsToken0 = WETH == IUniswapV3Pool(poolAddress).token0();
        return aIsToken0 ? token1PerToken0 : Math.mulDiv(Q96, Q96, token1PerToken0);
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

    function _one(address value) internal pure returns (address[] memory one) {
        one = new address[](1);
        one[0] = value;
    }

    function _one(uint256 value) internal pure returns (uint256[] memory one) {
        one = new uint256[](1);
        one[0] = value;
    }
}
