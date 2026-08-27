// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IWindowBook} from "../interfaces/IWindowBook.sol";
import {Order, Side, WindowResult} from "../types/Types.sol";

/// @title WindowBook — the L2 product surface (WP-2, CT-7 … CT-14).
/// @notice Phase 2b stub — owner implements. Escrow, crossing, the price band,
/// fee booking and CT-10's last check all land here and nowhere else.
///
/// Every stub body only reverts, so solc asks for the strictest mutability and
/// each is marked `pure` — an override may narrow, never widen. The interface
/// carries the real mutability; the owning phase drops `pure` as it writes
/// each body.
contract WindowBook is IWindowBook {
    /// @inheritdoc IWindowBook
    function place(Order calldata) external payable returns (bytes32) {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function cancel(bytes32) external pure {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function reclaim(bytes32) external pure {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function withdraw(address, uint256) external pure {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function quote(uint256, Side) external pure returns (uint256, uint32, uint32) {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function latestPrice() external pure returns (uint256, uint64, uint32) {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function settleWindow(bytes32[] calldata, uint64) external pure {
        revert("not implemented: Phase 2b");
    }

    /// @inheritdoc IWindowBook
    function setSettler(address) external pure {
        revert("not implemented: Phase 2b");
    }
}
