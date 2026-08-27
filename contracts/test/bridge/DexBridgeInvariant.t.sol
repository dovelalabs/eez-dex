// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DexBridge} from "../../src/bridge/DexBridge.sol";
import {DexBridgeL2} from "../../src/bridge/DexBridgeL2.sol";
import {Credit} from "../../src/interfaces/IDexBridge.sol";

import {MockERC20, MockERC20Decimals6} from "../mocks/MockERC20.sol";
import {BridgeFixture} from "./BridgeFixture.sol";

/// @notice Drives the bridge pair the way the product does: inbound deposits,
/// outbound withdrawals, whole settlement legs (release the sell side, deposit
/// the bought side), plus the operational edges — pausing, donations that were
/// never deposited, and time passing through rate-limit windows.
contract BridgeHandler is Test {
    DexBridge internal immutable BRIDGE;
    DexBridgeL2 internal immutable BRIDGE_L2;
    address internal immutable GUARDIAN;
    address internal immutable GOVERNANCE;

    address[] internal tokens;
    address[] internal actors;

    address internal router = makeAddr("handlerRouter");

    constructor(
        DexBridge bridge_,
        DexBridgeL2 bridgeL2_,
        address guardian_,
        address governance_,
        address[] memory tokens_,
        address[] memory actors_
    ) {
        BRIDGE = bridge_;
        BRIDGE_L2 = bridgeL2_;
        GUARDIAN = guardian_;
        GOVERNANCE = governance_;
        tokens = tokens_;
        actors = actors_;
    }

    /// @notice The inbound leg: the depositor transfers in, then calls.
    function deposit(uint256 tokenSeed, uint256 actorSeed, uint256 amount) public {
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 1e24);

        MockERC20(token).mint(address(BRIDGE), amount);
        BRIDGE.deposit(token, amount, _credits(actor, amount));
    }

    /// @notice The outbound leg on its own: burn on L2, release on L1.
    function withdraw(uint256 tokenSeed, uint256 actorSeed, uint256 amount) public {
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        uint256 balance = IERC20(BRIDGE_L2.l2TokenFor(token)).balanceOf(actor);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);

        vm.prank(actor);
        BRIDGE_L2.burn(token, actor, amount);
    }

    /// @notice A whole settlement frame: the sell side is released to the
    /// router, the router swaps, and the bought side is deposited back for L2
    /// credit (CT-5).
    function settlementLeg(uint256 sellSeed, uint256 buySeed, uint256 actorSeed, uint256 amount) public {
        address sell = _token(sellSeed);
        address buy = _token(buySeed);
        address actor = _actor(actorSeed);
        uint256 balance = IERC20(BRIDGE_L2.l2TokenFor(sell)).balanceOf(actor);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);

        vm.prank(actor);
        BRIDGE_L2.releaseTo(sell, actor, amount, router);

        // The router's swap, abstracted: some amount of the bought asset comes
        // back. WP-1 owns the real one; the reserve maths is the same either way.
        uint256 bought = amount == 0 ? 0 : bound(uint256(keccak256(abi.encode(amount, buy))), 1, 1e24);
        MockERC20(buy).mint(address(BRIDGE), bought);
        BRIDGE.deposit(buy, bought, _credits(actor, bought));
    }

    /// @notice Tokens sent to the bridge without a deposit. They are not
    /// reserve and must not move the invariant either way.
    function donate(uint256 tokenSeed, uint256 amount) public {
        MockERC20(_token(tokenSeed)).mint(address(BRIDGE), bound(amount, 1, 1e24));
    }

    /// @dev Pausing is an exceptional operation; if it fired as often as every
    /// other action the bridge would spend most of the run halted and the value
    /// paths would go unexercised.
    function pause(uint256 seed) public {
        if (seed % 8 != 0) return;
        vm.prank(GUARDIAN);
        seed % 16 == 0 ? BRIDGE_L2.pause() : BRIDGE.pause();
    }

    function unpause(bool l2Side) public {
        vm.prank(GOVERNANCE);
        l2Side ? BRIDGE_L2.unpause() : BRIDGE.unpause();
    }

    /// @notice Crosses rate-limit windows so the limiter's reset path is walked.
    function passTime(uint256 seconds_) public {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 hours));
    }

    function tokenAt(uint256 i) external view returns (address) {
        return tokens[i];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function _credits(address recipient, uint256 amount) private pure returns (Credit[] memory credits) {
        credits = new Credit[](1);
        credits[0] = Credit({recipient: recipient, amount: amount});
    }

    function _token(uint256 seed) private view returns (address) {
        return tokens[seed % tokens.length];
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }
}

/// @title TS-B — the reserve invariant (WP-B, EC-4).
/// @notice `Σ locked == Σ L2 supply` per token, at every reachable state. It is
/// the whole of the bridge custodian's promise: the L1 reserves back the L2
/// balances one-for-one and the DEX never holds a position against them.
contract DexBridgeInvariantTest is BridgeFixture {
    BridgeHandler internal handler;

    function setUp() public {
        _deployBridgePair();

        address[] memory tokens = new address[](2);
        tokens[0] = address(new MockERC20("Wrapped Ether", "WETH", 18));
        tokens[1] = address(new MockERC20Decimals6("USD Coin", "USDC"));

        _registerToken(tokens[0], "eez Wrapped Ether", "eezWETH", 18, NO_RATE_LIMIT);
        // A finite limit on the second token, so the limiter is on the path too.
        _registerToken(tokens[1], "eez USD Coin", "eezUSDC", 6, 1e12);

        address[] memory actors = new address[](3);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");

        handler = new BridgeHandler(bridge, bridgeL2, guardian, address(timelockL1), tokens, actors);
        targetContract(address(handler));
    }

    /// @notice Per token: the L1 reserve equals the L2 representation's total
    /// supply. Nothing — a deposit, a withdrawal, a settlement leg, a pause, a
    /// donation, or a reverted frame — moves one without the other.
    function invariant_reserveEqualsL2Supply() public view {
        uint256 count = handler.tokenCount();
        for (uint256 i = 0; i < count; ++i) {
            address token = handler.tokenAt(i);
            assertEq(bridge.locked(token), _l2Supply(token), "reserve invariant: locked must equal the L2 supply");
        }
    }

    /// @notice The reserve is never more than the bridge actually holds; a
    /// donation may make the balance larger, never smaller.
    function invariant_reserveIsBackedByRealBalance() public view {
        uint256 count = handler.tokenCount();
        for (uint256 i = 0; i < count; ++i) {
            address token = handler.tokenAt(i);
            assertGe(IERC20(token).balanceOf(address(bridge)), bridge.locked(token), "reserve exceeds the balance");
        }
    }
}
