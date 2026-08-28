// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Credit, IDexBridge} from "../../../src/interfaces/IDexBridge.sol";

/// @notice The soft contract with Phase 2c, mocked (README "soft cross-phase
/// contracts"). WP-1 imports the frozen `IDexBridge` and tests against this;
/// the real `release` -> swap -> `deposit` round trip is Phase 6's.
///
/// It keeps only what the L1 leg can observe: `release` funds the router the
/// way the outbound leg does, and `deposit` insists the tokens arrived before
/// it credits, which is what makes a router that forgets to transfer fail here.
contract MockDexBridge is IDexBridge {
    using SafeERC20 for IERC20;

    error ShortReserve(uint256 have, uint256 want);
    error DepositNotFunded(uint256 have, uint256 want);
    error CreditsDoNotSum(uint256 credited, uint256 amount);

    struct Deposit {
        address token;
        uint256 amount;
        address recipient;
    }

    Deposit[] public deposits;
    mapping(address token => uint256 locked) public locked;

    function release(address token, uint256 amount, address to) external {
        uint256 reserve = IERC20(token).balanceOf(address(this));
        if (reserve < amount) revert ShortReserve(reserve, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    function deposit(address token, uint256 amount, Credit[] calldata recipients) external {
        if (IERC20(token).balanceOf(address(this)) < locked[token] + amount) {
            revert DepositNotFunded(IERC20(token).balanceOf(address(this)), locked[token] + amount);
        }
        uint256 credited;
        for (uint256 i = 0; i < recipients.length; ++i) {
            credited += recipients[i].amount;
            deposits.push(Deposit({token: token, amount: recipients[i].amount, recipient: recipients[i].recipient}));
        }
        if (credited != amount) revert CreditsDoNotSum(credited, amount);
        locked[token] += amount;
    }

    function depositCount() external view returns (uint256) {
        return deposits.length;
    }
}

/// @notice A recipient that refuses value, for the delivery-failure path.
contract RevertingReceiver {
    error NoThankYou();

    receive() external payable {
        revert NoThankYou();
    }
}
