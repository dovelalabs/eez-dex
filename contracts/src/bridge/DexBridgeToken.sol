// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title [full] DexBridgeToken — the L2 representation of an L1 ERC-20 (WP-B, CT-11).
/// @notice One instance per bridged L1 token, deployed by `DexBridgeL2`. Only
/// that bridge may mint or burn, so the token's total supply is exactly the
/// L2 side of the reserve invariant `Σ locked == Σ L2 supply` (EC-4).
///
/// The decimals of the L1 token are mirrored so amounts are the same integer
/// on both chains and the bridge never rescales.
///
/// AUDIT REQUIRED before any public testnet holds real value (RD-2 §12).
contract DexBridgeToken is ERC20 {
    /// @notice The `DexBridgeL2` instance that deployed this token; the only
    /// address that may mint or burn.
    address public immutable BRIDGE;

    /// @notice The L1 token this contract represents on L2.
    address public immutable L1_TOKEN;

    uint8 private immutable _DECIMALS;

    error OnlyBridge();

    modifier onlyBridge() {
        if (msg.sender != BRIDGE) revert OnlyBridge();
        _;
    }

    constructor(address l1Token_, string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        BRIDGE = msg.sender;
        L1_TOKEN = l1Token_;
        _DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Mints against reserves locked in `DexBridge` on L1.
    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    /// @notice Burns the representation; the bridge releases the L1 reserve in
    /// the same frame.
    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }

    /// @notice Spends `spender`'s allowance over `owner`, for the bridge's
    /// delegated-withdrawal path. Reverts unless the allowance covers `amount`.
    function spendAllowance(address owner, address spender, uint256 amount) external onlyBridge {
        _spendAllowance(owner, spender, amount);
    }
}
