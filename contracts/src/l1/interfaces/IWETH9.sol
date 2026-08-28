// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title The canonical wrapped-ether contract, as much of it as the L1 leg uses.
/// @notice The rail moves only ETH at the protocol layer (RD-2 §1), and a
/// Uniswap v3 pool trades only ERC-20s. Every leg whose sell side arrives as
/// `msg.value` is therefore wrapped here before the swap, and every leg whose
/// buy side leaves as native value is unwrapped here after it (CT-4, CT-5).
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
