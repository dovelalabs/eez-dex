// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice One recipient's share of an inbound ERC-20 delivery: the L2 address
/// to credit and the amount in the token's own units.
struct Credit {
    address recipient;
    uint256 amount;
}

/// @title [full] The DEX's own L1 bridge — RD-2 CT-5, A.3, §3.
/// @notice FROZEN AT THE SCAFFOLD. WP-B implements it; WP-1 calls `deposit`.
/// The rail moves only ETH at the protocol layer, so every ERC-20 movement in
/// the settlement frame is an ordinary contract call through the framework's
/// `CrossChainProxy` — failure anywhere reverts the frame and is evicted free.
///
/// This contract holds locked reserves backing L2 balances one-for-one. That
/// is custody, not inventory (EC-2): the invariant is
/// `Σ locked == Σ L2 supply` per token, auditable on L1 at any time.
interface IDexBridge {
    /// @notice Outbound leg: hands `amount` of `token` to `to` (the router)
    /// so the residual swap has its sell side.
    /// @dev `onlyBridgeProxy` — the sole caller is the L1-side proxy driven on
    /// behalf of `DexBridgeL2`. A short reserve reverts and the frame is
    /// evicted at zero L1 cost (CT-5).
    function release(address token, uint256 amount, address to) external;

    /// @notice Inbound leg: locks `amount` of `token` already transferred in
    /// and makes the L1->L2 proxy call that credits `DexBridgeL2` balances.
    /// @dev An ordinary call in the same frame, so its failure reverts
    /// everything. `Σ recipients[i].amount` must equal `amount` (CT-5, CT-11).
    function deposit(address token, uint256 amount, Credit[] calldata recipients) external;
}
