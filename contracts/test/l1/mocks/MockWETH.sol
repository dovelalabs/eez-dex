// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IWETH9} from "../../../src/l1/interfaces/IWETH9.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";

/// @notice The wrapper the L1 leg wraps a value sell side into and unwraps a
/// value buy side out of — canonical WETH9 behaviour, nothing more.
contract MockWETH is MockERC20, IWETH9 {
    error WithdrawFailed();

    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() public payable {
        mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    receive() external payable {
        deposit();
    }
}
