# 12 Test Coverage Checklist

This checklist records the current automated coverage and, importantly, the boundary of each test suite. A frontend test with mocked APIs is not counted as backend route coverage, and a provider mock is not counted as a live-provider test.

## Cross-service integration harness

`scripts/e2e/local-loop.sh test` currently verifies these flows against real backend and bot processes, Postgres, and the local GitHub mock:

- Installation webhook -> bot signature -> backend installation/repository persistence.
- Pull-request webhook -> backend challenge and outbox action -> bot gate-comment upsert -> backend acknowledgement.
- Pending close action -> bot PR close and timeout comment -> backend acknowledgement.

The harness does not currently start the frontend or an EVM chain.

## Backend tests

The default `cargo test` suite covers:

- Configuration parsing, address and threshold validation, error-code mapping, and internal-error redaction.
- Session-token hashing, OAuth-token encryption, internal Ed25519 signature verification, and replay payload binding.
- Rate-limit enforcement, window reset, per-key isolation, and expired-key eviction.
- GitHub authorization URL construction plus mocked repository lookup, pagination/deduplication, and concurrent login resolution.
- Controlled HTTP tests for quote-provider endpoint/parsing behavior and stake-RPC encoding, validation, and parallel reads.
- Pure route decisions such as challenge supersession, bot-action backoff/idempotency, redirect validation, and whitelist normalization.
- Database-unavailable health behavior and unauthenticated stake-status rejection.

Postgres-backed tests are ignored by default and require a disposable `DATABASE_URL` plus explicit selection with `--ignored`. They cover:

- Delivery/replay uniqueness and pending-action constraints.
- Bot-action claim, result, retry-backoff, and expired-lease behavior.
- Concurrent deadline sweeping, bounded retention cleanup, and quote-cache single-flight/fallback behavior.
- Atomic wallet-nonce consumption, canonical repository-name propagation, token migration, and database-ready health behavior.

## Bot-worker tests

`npm test` covers:

- GitHub webhook signature validation, normalization, and unsupported-action handling.
- Signed v2 event forwarding, repository backfill, body-bound signatures, and fresh retry nonces.
- Outbox polling and acknowledgements for success, permanent failure, and retryable GitHub failure.
- Stale installation recovery and terminal handling when an installation cannot be resolved.
- GitHub token single-flight caching, paginated comment/repository lookup, retry classification, and hung-request timeouts.

## Smart-contract tests

`forge test` covers:

- Stake creation and accumulation, lock resets, unlock boundaries, and per-user isolation.
- Withdraw and withdraw-to flows, including non-payable recipients.
- Reentrancy resistance and prevention of withdrawing another user's stake.
- Accounting views (`totalStaked`, `excessBalance`) under forced ETH and withdrawals.
- Fuzzed stake/withdraw behavior.

## Frontend tests

`npm test` uses Vitest, Testing Library, and jsdom with mocked API and wallet clients. It covers:

- API request/response/error mapping, 204 and optional-404 handling, and one-request GitHub OAuth startup.
- Owner repository selection, configuration, GitHub App state, disconnected-repository locking, whitelist list/add/delete behavior, and stale-selection recovery.
- Wallet link/unlink and unlocked withdrawal interactions.
- Gate rendering, pending-status polling, terminal-state handling, author identity checks, wallet linking, lock renewal, and typed-data confirmation safeguards.
- EIP-712 normalization, staking-configuration validation, state context, and basic page rendering.

These tests validate frontend behavior; they do not send requests to a real backend or drive a real browser wallet.

## Known gaps

- GitHub OAuth callback token exchange and user fetch against either a protocol-level mock or live GitHub.
- HTTP-level backend integration for the complete owner configuration, whitelist, wallet-link, and gate-confirmation journeys.
- A single E2E flow spanning the rendered frontend, backend, deployed contract, and bot.
- Browser-engine E2E for rendering, routing, cookies, network behavior, and wallet-provider interaction.
- Live GitHub side effects are untested; live quote-provider checks are opt-in smoke tests rather than deterministic CI coverage.
- Multi-replica bot behavior with concurrent workers, process interruption, and restart recovery.
- Private-repository behavior; the current product scope is public repositories.

## Recommended next increments

1. Add backend HTTP integration tests for OAuth callback, owner configuration/whitelist, wallet linking, and gate confirmation using controlled GitHub and RPC servers.
2. Add Playwright journeys for Owner, Wallet, and Gate pages against an expanded local harness with a deterministic EVM chain.
3. Add fault-injection coverage for transient GitHub failures and worker restarts.
4. Run two bot workers against one backend database to validate claim exclusivity and lease recovery at the process level.
