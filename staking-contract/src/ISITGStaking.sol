// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISITGStaking {
    error AmountZero();
    error InsufficientBalance();
    error LockActive();
    error EthTransferFailed();
    error InvalidRecipient();

    event Staked(address indexed user, uint256 amountAdded, uint256 newBalance, uint256 unlockTime);
    event Withdrawn(address indexed user, address indexed recipient, uint256 amountWithdrawn);

    function stake() external payable;
    function withdraw() external;
    function withdrawTo(address payable recipient) external;

    function stakedBalance(address user) external view returns (uint256);
    function unlockTime(address user) external view returns (uint256);
    function lockDuration() external view returns (uint256);
    function isStakeActive(address user) external view returns (bool);
    function totalStaked() external view returns (uint256);
    function excessBalance() external view returns (uint256);
}
