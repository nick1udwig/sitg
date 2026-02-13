// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakeToContribute {
    event Staked(address indexed user, uint256 amount, uint256 newBalance, uint256 unlockTime);
    event Withdrawn(address indexed user, uint256 amount, uint256 remainingBalance);

    function stake() external payable;
    function withdraw(uint256 amountWei) external;

    function stakedBalance(address user) external view returns (uint256);
    function unlockTime(address user) external view returns (uint256);
    function lockDuration() external view returns (uint256);
    function isStakeActive(address user) external view returns (bool);
}
