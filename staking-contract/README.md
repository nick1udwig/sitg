# Stake-to-Contribute Smart Contract

Foundry package implementing the MVP staking contract from `docs/03-smart-contract.md`.

## Contract

- `src/IStakeToContribute.sol`: Interface from the product spec.
- `src/StakeToContribute.sol`: Minimal ETH staking implementation.

Behavior implemented:
- `stake()` requires `msg.value > 0`, accumulates balance, and resets unlock to `block.timestamp + 30 days`.
- `withdraw(amountWei)` requires positive amount, sufficient balance, and elapsed lock.
- `isStakeActive(user)` is `balance > 0 && block.timestamp < unlockTime`.

## Tests

- `test/StakeToContribute.t.sol` covers lock duration, stake/withdraw guards, lock reset on restake, and active boundary semantics.

## Run

```bash
forge test -vv
```

If your environment is offline, pre-install a compatible `solc` version in Foundry before running tests.
