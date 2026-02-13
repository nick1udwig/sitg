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
```

## Behavior rules

1. `stake()`
- Requires `msg.value > 0` only if caller has zero staked balance.
- Adds `msg.value` to caller balance.
- Resets caller unlock time to `block.timestamp + LOCK_DURATION` even if caller already had stake.
- If caller already has stake, a zero-value call is valid and acts as lock refresh only.

2. `withdraw()`
- Requires `stakedBalance(msg.sender) > 0`.
- Requires `block.timestamp >= unlockTime(msg.sender)`.
- Transfers the full staked balance to sender and sets staked balance to zero.
- Clears `unlockTime(msg.sender)` to zero after successful full withdrawal.
- Emits `Withdrawn(msg.sender, msg.sender, amount)`.

3. `withdrawTo(recipient)`
- Same checks/state updates as `withdraw()` for the caller's stake.
- Transfers full caller stake to `recipient`.
- `recipient` must be non-zero.
- Emits `Withdrawn(msg.sender, recipient, amount)`.

4. `isStakeActive(user)`
- Returns `stakedBalance(user) > 0 && block.timestamp < unlockTime(user)`.

5. Accounting views
- `totalStaked()` tracks the sum of user-owned stake as maintained by contract state.
- `excessBalance()` is `address(this).balance - totalStaked()`.

## Eligibility rule used by backend

Contributor is eligible for repo threshold iff:
- `stakedBalance(wallet) >= thresholdWei`, and
- `block.timestamp < unlockTime(wallet)`.

`stakedBalance(wallet)` is the sole source of truth for stake ownership and eligibility checks.

## Forced ETH behavior

- ETH can be forced into the contract balance (e.g., `selfdestruct`) without touching user stake mappings.
- This can make `address(this).balance` greater than `totalStaked()`.
- Such excess ETH is not attributed to any staker, does not increase eligibility, and is treated as unrecoverable donation in this immutable/no-admin design.

## Explicit exclusions

- No admin withdrawal.
- No pause switch (unless added for emergency policy later).
- No `extendLock()`.
- No per-user custom lock duration.
