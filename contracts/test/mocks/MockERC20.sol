// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title Test tokens — RD-2 TS-1, HX-1.
/// @notice FROZEN AT THE SCAFFOLD. WP-1 and WP-B unit-test against these, and
/// WP-4 packages them into the enclave deployment bundle, so they live here
/// rather than in either.
///
/// `MockERC20` is a plain, mintable ERC-20 with configurable decimals.
/// `MockFeeOnTransferERC20` and the 6-decimal shape exist because TS-1 requires
/// that both are rejected or handled as specified — a token whose
/// `transferFrom` delivers less than it was asked for silently breaks the
/// escrow invariant (CT-13) unless the book measures the delivered amount.
contract MockERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) public virtual {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) public virtual {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) public virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice A token that delivers less than it was sent: `feeBps` of every
/// transfer is burned in flight. The recipient's balance rises by
/// `amount - fee`, not by `amount`.
contract MockFeeOnTransferERC20 is MockERC20 {
    uint16 public feeBps;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint16 feeBps_
    )
        MockERC20(name_, symbol_, decimals_)
    {
        require(feeBps_ <= 10_000, "fee > 100%");
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external {
        require(feeBps_ <= 10_000, "fee > 100%");
        feeBps = feeBps_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @notice A six-decimal token, the shape of USDC and USDT. Q96 price
/// arithmetic is decimal-agnostic, but per-order rounding is not: one wei of
/// dust here is 10**12 times the dust of an 18-decimal token (CT-12).
contract MockERC20Decimals6 is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 6) {}
}
