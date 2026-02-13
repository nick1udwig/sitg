# 03 Smart Contract Spec

## Goals

- Minimal, auditable ETH staking contract.
- Non-custodial user interaction.
- Fixed lock duration at deployment.

## Network

- Base mainnet (chain ID `8453`) for production.
- Base Sepolia for test deployments.

## Parameters

- `LOCK_DURATION = 30 days` (immutable at deploy time).

## Interface

```solidity
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
```

## Behavior rules

1. `stake()`
- Requires `msg.value > 0`.
- Adds `msg.value` to caller balance.
- Resets caller unlock time to `block.timestamp + LOCK_DURATION` even if caller already had stake.

2. `withdraw(amountWei)`
- Requires `amountWei > 0`.
- Requires `amountWei <= stakedBalance(msg.sender)`.
- Requires `block.timestamp >= unlockTime(msg.sender)`.
- Subtracts amount and transfers ETH to sender.

3. `isStakeActive(user)`
- Returns `stakedBalance(user) > 0 && block.timestamp < unlockTime(user)`.

## Eligibility rule used by backend

Contributor is eligible for repo threshold iff:
- `stakedBalance(wallet) >= thresholdWei`, and
- `block.timestamp < unlockTime(wallet)`.

## Explicit exclusions

- No admin withdrawal.
- No pause switch (unless added for emergency policy later).
- No `extendLock()`.
- No per-user custom lock duration.

