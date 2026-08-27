// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Credit} from "../../../src/interfaces/IDexBridge.sol";
import {IDexBridgeL2} from "../../../src/interfaces/IDexBridgeL2.sol";
import {ISettlementRouter} from "../../../src/interfaces/ISettlementRouter.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {Mirror} from "../../../src/l2/Mirror.sol";
import {PoolState, Side, WindowLeg, WindowResult} from "../../../src/types/Types.sol";

/// @notice The framework registry as WP-2 uses it: the one call `WindowBook` makes to
/// derive the zone proxy rather than hard-coding it (RD-2 §3).
/// @dev Phase 2a implements the real `SettlementRouter` on a parallel branch. WP-2 owns
/// neither it nor the framework, so the soft contract between them is mocked here: the
/// registry hands back a proxy, and the proxy returns a crafted `WindowResult`.
contract MockEEZManager {
    mapping(bytes32 key => address proxy) private _proxies;

    function register(address originalAddress, uint64 originalRollupId, address proxy) external {
        _proxies[keccak256(abi.encodePacked(originalAddress, originalRollupId))] = proxy;
    }

    function computeCrossChainProxyAddress(
        address originalAddress,
        uint64 originalRollupId
    )
        external
        view
        returns (address)
    {
        return _proxies[keccak256(abi.encodePacked(originalAddress, originalRollupId))];
    }

    function createCrossChainProxy(address originalAddress, uint64 originalRollupId) external view returns (address) {
        return _proxies[keccak256(abi.encodePacked(originalAddress, originalRollupId))];
    }
}

/// @notice The L2->L1 frame, collapsed into one contract for a unit test.
/// @dev Standing in for `CrossChainProxy` + `SettlementRouter` + `DexBridge` at once, it
/// does exactly what the frame does and nothing more:
///
/// - decodes `settle(WindowLeg[])` from the proxy call, and **records the leg** so a
///   test can assert what the *contract* built (CT-9);
/// - reads `P0` from its own pool state and reverts unless it is inside the leg's band;
/// - swaps the residual along the same curve `Mirror` models, then reverts unless the
///   realised average price is inside the band too (CT-1) — which is how a favourable
///   move that breaks a crossed order's limit fails free;
/// - delivers the bought asset into the book inside the call, as the bridge credit or
///   the incoming `value` does (CT-11) — **[genesis]** delivers nothing, because the
///   router paid the recipients on L1;
/// - returns `abi.encode(WindowResult[])`, which is what the real proxy hands back:
///   the L1 call's raw return data, unwrapped.
///
/// `setPoolState` is the drift lever: move it between placement and settlement and the
/// mirror and the L1 head diverge, exactly as the HX-3 `drift` op does.
contract MockZoneProxy {
    uint256 private constant Q96 = 0x1000000000000000000000000;

    error BandRejectedReferencePrice(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);
    error BandRejectedExecutionPrice(uint256 priceX96, uint256 minPriceX96, uint256 maxPriceX96);
    error UnexpectedSelector(bytes4 selector);

    PoolState public poolState;
    uint64 public l1Block = 1;

    address public book;
    address public assetA;
    address public assetB;
    /// @notice **[genesis]** delivery is the L1 distribution, so nothing lands on L2.
    bool public deliversOnL2 = true;

    /// @dev The last leg the book built. Read it through `leg()`: an auto-generated
    /// getter drops the struct's `bytes distribution`, which is exactly the field the
    /// genesis distribution test needs (CT-4).
    WindowLeg private _lastLeg;
    uint256 public callCount;
    uint256 public lastValue;

    /// @notice Forces the frame to revert, standing in for `Expired`, a short bridge
    /// reserve, or any other L1-side failure (FL-7).
    bool public revertNextCall;

    /// @notice Returns a crafted result instead of executing, band checks and all
    /// skipped — a settler and a router colluding, or simply broken. CT-10 is the guard
    /// that has to survive it.
    bool public forceResult;
    bool public forcedDelivers;
    WindowResult private _forced;

    receive() external payable {}

    function configure(address book_, address assetA_, address assetB_, bool deliversOnL2_) external {
        book = book_;
        assetA = assetA_;
        assetB = assetB_;
        deliversOnL2 = deliversOnL2_;
    }

    /// @notice The last leg the book built, whole (CT-9, leg parity).
    function leg() external view returns (WindowLeg memory) {
        return _lastLeg;
    }

    function setPoolState(PoolState memory state) external {
        poolState = state;
    }

    function setL1Block(uint64 l1Block_) external {
        l1Block = l1Block_;
    }

    function setRevertNextCall(bool value) external {
        revertNextCall = value;
    }

    function setForcedResult(WindowResult memory result, bool delivers) external {
        forceResult = true;
        forcedDelivers = delivers;
        _forced = result;
    }

    fallback(bytes calldata data) external payable returns (bytes memory) {
        if (revertNextCall) revert("l1 leg reverted");
        bytes4 selector = bytes4(data[:4]);
        if (selector != ISettlementRouter.settle.selector) revert UnexpectedSelector(selector);

        WindowLeg[] memory legs = abi.decode(data[4:], (WindowLeg[]));
        _lastLeg = legs[0];
        callCount += 1;
        lastValue = msg.value;

        WindowResult[] memory results = new WindowResult[](1);
        results[0] = _settle(legs[0]);
        return abi.encode(results);
    }

    function _settle(WindowLeg memory windowLeg) private returns (WindowResult memory result) {
        if (forceResult) {
            result = _forced;
            if (forcedDelivers && result.amountOut != 0) {
                address buyAsset = windowLeg.residualSide == Side.SELL_A_FOR_B ? assetB : assetA;
                _deliver(buyAsset, result.amountOut);
            }
            return result;
        }

        uint256 p0 = Mirror.spotPriceX96(poolState);
        if (p0 < windowLeg.minPriceX96 || p0 > windowLeg.maxPriceX96) {
            revert BandRejectedReferencePrice(p0, windowLeg.minPriceX96, windowLeg.maxPriceX96);
        }

        result.referencePriceX96 = p0;
        result.executionPriceX96 = p0;
        result.amountIn = windowLeg.residualIn;
        result.l1Block = l1Block;
        result.post = poolState;

        if (windowLeg.residualIn != 0) {
            (PoolState memory post, uint256 amountOut) =
                Mirror.advance(poolState, windowLeg.residualIn, windowLeg.residualSide);
            uint256 execPriceX96 = windowLeg.residualSide == Side.SELL_A_FOR_B
                ? Math.mulDiv(amountOut, Q96, windowLeg.residualIn)
                : Math.mulDiv(windowLeg.residualIn, Q96, amountOut);
            if (execPriceX96 < windowLeg.minPriceX96 || execPriceX96 > windowLeg.maxPriceX96) {
                revert BandRejectedExecutionPrice(execPriceX96, windowLeg.minPriceX96, windowLeg.maxPriceX96);
            }

            poolState = post;
            result.post = post;
            result.amountOut = amountOut;
            result.executionPriceX96 = execPriceX96;

            if (deliversOnL2) {
                address buyAsset = windowLeg.residualSide == Side.SELL_A_FOR_B ? assetB : assetA;
                _deliver(buyAsset, amountOut);
            }
        }
    }

    /// @dev The inbound half of the frame: a `DexBridgeL2` credit for an ERC-20, the
    /// incoming call's `value` for ETH (CT-11).
    function _deliver(address asset, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = book.call{value: amount}("");
            require(ok, "eth delivery failed");
        } else {
            require(IERC20(asset).transfer(book, amount), "token delivery failed");
        }
    }
}

/// @notice The L2 side of an ERC-20 movement, as `WindowBook` uses it (CT-11).
/// @dev Phase 2c owns the real `DexBridgeL2`; WP-2 only ever calls it through the frozen
/// interface, so this mock implements exactly the two things the book needs: a token map
/// and a burn that really destroys the L2 representation backing the L1 reserve.
contract MockDexBridgeL2 is IDexBridgeL2 {
    mapping(address l1Token => address l2Token) private _l2Tokens;

    function map(address l1Token, address l2Token) external {
        _l2Tokens[l1Token] = l2Token;
    }

    function l2TokenFor(address l1Token) external view returns (address) {
        return _l2Tokens[l1Token];
    }

    function credit(address l1Token, Credit[] calldata credits) external {
        for (uint256 i = 0; i < credits.length; ++i) {
            MockERC20(_l2Tokens[l1Token]).mint(credits[i].recipient, credits[i].amount);
            emit Minted(l1Token, credits[i].recipient, credits[i].amount);
        }
    }

    function mint(address l1Token, address to, uint256 amount) external {
        MockERC20(_l2Tokens[l1Token]).mint(to, amount);
        emit Minted(l1Token, to, amount);
    }

    function burn(address l1Token, address from, uint256 amount) external {
        MockERC20(_l2Tokens[l1Token]).burn(from, amount);
        emit Burned(l1Token, from, amount);
    }
}
