// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISITGStaking} from "./ISITGStaking.sol";

contract SITGStaking is ISITGStaking {
    uint256 private immutable _lockDuration;
    uint256 private _totalStaked;
    mapping(address => uint256) private _stakedBalance;
    mapping(address => uint256) private _unlockTime;

    constructor() {
        _lockDuration = 30 days;
    }

    function stake() external payable {
        uint256 currentBalance = _stakedBalance[msg.sender];
        if (msg.value == 0 && currentBalance == 0) revert AmountZero();

        uint256 newBalance = currentBalance + msg.value;
        uint256 userUnlockTime = block.timestamp + _lockDuration;

        _totalStaked += msg.value;
        _stakedBalance[msg.sender] = newBalance;
        _unlockTime[msg.sender] = userUnlockTime;

        emit Staked(msg.sender, msg.value, newBalance, userUnlockTime);
    }

    function withdraw() external {
        withdrawTo(payable(msg.sender));
    }

    function withdrawTo(address payable recipient) public {
        if (recipient == address(0)) revert InvalidRecipient();

        uint256 currentBalance = _stakedBalance[msg.sender];
        if (currentBalance == 0) revert InsufficientBalance();
        if (block.timestamp < _unlockTime[msg.sender]) revert LockActive();

        _totalStaked -= currentBalance;
        _stakedBalance[msg.sender] = 0;
        _unlockTime[msg.sender] = 0;

        (bool ok, ) = recipient.call{value: currentBalance}("");
        if (!ok) revert EthTransferFailed();

        emit Withdrawn(msg.sender, recipient, currentBalance);
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

    function totalStaked() external view returns (uint256) {
        return _totalStaked;
    }

    function excessBalance() external view returns (uint256) {
        return address(this).balance - _totalStaked;
    }
}
