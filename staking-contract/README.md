# SITG Smart Contract

Foundry package implementing the MVP staking contract from `docs/03-smart-contract.md`.

## Contract

- `src/ISITGStaking.sol`: Interface from the product spec.
- `src/SITGStaking.sol`: Minimal ETH staking implementation.

Behavior implemented:
- `stake()` requires positive value only for first stake; existing stakers may call with `0` to refresh lock.
- Staking always sets unlock to `block.timestamp + 30 days` (never additive beyond one lock window).
- `withdraw()` (no args) requires balance and elapsed lock, then withdraws the full staked amount.
- `isStakeActive(user)` is `balance > 0 && block.timestamp < unlockTime`.
- `Staked(user, amountAdded, newBalance, unlockTime)` emits for both funded stake and zero-value lock refresh.
- `Withdrawn(user, amountWithdrawn)` emits on full withdraw.

## Tests

- `test/SITGStaking.t.sol` covers lock duration, stake/withdraw guards, lock reset on restake, and active boundary semantics.

## Run

```bash
forge test -vv
```

If your environment is offline, pre-install a compatible `solc` version in Foundry before running tests.

## Deploy

Set environment variables:

```bash
export PRIVATE_KEY=0x...
export BASE_SEPOLIA_RPC_URL=https://...
export BASE_MAINNET_RPC_URL=https://...
```

Deploy to Base Sepolia:

```bash
forge script script/DeploySITGStaking.s.sol:DeploySITGStakingScript --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Deploy to Base mainnet:

```bash
forge script script/DeploySITGStaking.s.sol:DeploySITGStakingScript --rpc-url $BASE_MAINNET_RPC_URL --broadcast
```
