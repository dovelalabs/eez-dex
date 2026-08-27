// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {Order, PoolState, Side, WindowLeg, WindowResult} from "../../src/types/Types.sol";

/// @notice The shared types are frozen at the scaffold: WP-1, WP-2, WP-B and
/// WP-3 all compile against them, so a changed field name or width is a
/// rewrite for every one of them. These assertions pin the widths RD-2 A.1
/// states — each `type(uintN).max` below fails to compile if the field is
/// narrowed, and fails at runtime if it is widened.
contract TypesTest is Test {
    function test_a1_side_has_two_variants_in_order() public pure {
        assertEq(uint8(Side.SELL_A_FOR_B), 0);
        assertEq(uint8(Side.SELL_B_FOR_A), 1);
    }

    function test_a1_order_field_widths() public pure {
        Order memory o = Order({
            id: bytes32(type(uint256).max),
            owner: address(type(uint160).max),
            side: Side.SELL_B_FOR_A,
            sellAmount: type(uint256).max,
            minBuyAmount: type(uint256).max,
            recipient: address(type(uint160).max),
            expiresAfter: type(uint32).max
        });
        assertEq(o.expiresAfter, type(uint32).max, "expiresAfter is uint32 windows");
        assertEq(o.sellAmount, type(uint256).max);
        assertEq(abi.decode(abi.encode(o), (Order)).id, o.id, "Order round-trips through abi");
    }

    function test_a1_window_leg_field_widths() public pure {
        WindowLeg memory leg = WindowLeg({
            windowId: type(uint64).max,
            residualSide: Side.SELL_A_FOR_B,
            residualIn: type(uint256).max,
            minPriceX96: type(uint256).max,
            maxPriceX96: type(uint256).max,
            deadline: type(uint64).max,
            distribution: hex"c0ffee"
        });
        assertEq(leg.windowId, type(uint64).max, "windowId is uint64");
        assertEq(leg.deadline, type(uint64).max, "deadline is a uint64 unix timestamp, checked on L1");
        assertEq(abi.decode(abi.encode(leg), (WindowLeg)).distribution, leg.distribution);
    }

    function test_a1_pool_state_field_widths() public pure {
        PoolState memory state =
            PoolState({sqrtPriceX96: type(uint160).max, liquidity: type(uint128).max, tick: type(int24).max});
        assertEq(state.sqrtPriceX96, type(uint160).max, "sqrtPriceX96 is uint160");
        assertEq(state.liquidity, type(uint128).max, "liquidity is uint128");
        assertEq(state.tick, type(int24).max, "tick is a signed int24");
    }

    function test_a1_window_result_field_widths() public pure {
        WindowResult memory result = WindowResult({
            amountIn: type(uint256).max,
            amountOut: type(uint256).max,
            referencePriceX96: type(uint256).max,
            executionPriceX96: type(uint256).max,
            post: PoolState({sqrtPriceX96: 0, liquidity: 0, tick: type(int24).min}),
            l1Block: type(uint64).max
        });
        assertEq(result.l1Block, type(uint64).max, "l1Block is uint64");
        assertEq(result.post.tick, type(int24).min);
        assertEq(abi.decode(abi.encode(result), (WindowResult)).referencePriceX96, result.referencePriceX96);
    }
}
