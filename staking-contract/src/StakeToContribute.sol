// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStakeToContribute} from "./IStakeToContribute.sol";

contract StakeToContribute is IStakeToContribute {
    error AmountZero();
    error InsufficientBalance();
    error LockActive();
    error EthTransferFailed();

    uint256 private immutable _lockDuration;
    mapping(address => uint256) private _stakedBalance;
    mapping(address => uint256) private _unlockTime;

    constructor() {
        _lockDuration = 30 days;
    }

    function stake() external payable {
        if (msg.value == 0) revert AmountZero();

        uint256 newBalance = _stakedBalance[msg.sender] + msg.value;
        uint256 userUnlockTime = block.timestamp + _lockDuration;

        _stakedBalance[msg.sender] = newBalance;
        _unlockTime[msg.sender] = userUnlockTime;

        emit Staked(msg.sender, msg.value, newBalance, userUnlockTime);
    }

    function withdraw(uint256 amountWei) external {
        if (amountWei == 0) revert AmountZero();

        uint256 currentBalance = _stakedBalance[msg.sender];
        if (amountWei > currentBalance) revert InsufficientBalance();
        if (block.timestamp < _unlockTime[msg.sender]) revert LockActive();

        uint256 remaining = currentBalance - amountWei;
        _stakedBalance[msg.sender] = remaining;

        (bool ok, ) = payable(msg.sender).call{value: amountWei}("");
        if (!ok) revert EthTransferFailed();

        emit Withdrawn(msg.sender, amountWei, remaining);
    }

    function stakedBalance(address user) external view returns (uint256) {
        return _stakedBalance[user];
    }

    function unlockTime(address user) external view returns (uint256) {
        return _unlockTime[user];
    }

    function lockDuration() external view returns (uint256) {
        return _lockDuration;
    }

    function isStakeActive(address user) external view returns (bool) {
        return _stakedBalance[user] > 0 && block.timestamp < _unlockTime[user];
    }
}
