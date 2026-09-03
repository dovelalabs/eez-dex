// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Credit} from "./IDexBridge.sol";

/// @title [full] The L2 side of every ERC-20 movement — RD-2 CT-11, §3.
/// @notice FROZEN AT THE SCAFFOLD. WP-B implements it; WP-2's `WindowBook`
/// escrows and credits the representations it mints.
interface IDexBridgeL2 {
    event Minted(address indexed l1Token, address indexed to, uint256 amount);
    event Burned(address indexed l1Token, address indexed from, uint256 amount);

    /// @notice The L2 representation of an L1 token, or the zero address if
    /// the token is not bridged.
    function l2TokenFor(address l1Token) external view returns (address l2Token);

    /// @notice Delivery: mints the L2 representation of `l1Token` to every
    /// recipient in one call, inside the settlement frame.
    /// @dev Callable only through `DexBridge`'s proxy — the L1->L2 half of
    /// `IDexBridge.deposit`.
    function credit(address l1Token, Credit[] calldata credits) external;

    /// @notice Mints the L2 representation of `l1Token` against reserves
    /// locked on L1.
    function mint(address l1Token, address to, uint256 amount) external;

    /// @notice Burns the L2 representation, the L2 half of a withdrawal. The
    /// L1 reserve is released to `from`'s own L1 address.
    function burn(address l1Token, address from, uint256 amount) external;

    /// @notice Burns the L2 representation and releases the L1 reserve to
    /// `l1Recipient` — the settlement frame's ERC-20 sell side, where the
    /// recipient is `SettlementRouter` and not the burner (CT-5).
    /// @dev Added in Phase 6: CT-5 puts the released reserve at the router, so
    /// the swap that follows it in the same L1 frame has its sell side. `burn`
    /// cannot express that, and a frame built on it releases the reserve to
    /// `WindowBook`'s address on L1 — where nothing is deployed — and reverts
    /// in the router with the reserve stranded. `DexBridgeL2` already
    /// implemented this; only the frozen interface was missing it.
    function releaseTo(address l1Token, address from, uint256 amount, address l1Recipient) external;
}
