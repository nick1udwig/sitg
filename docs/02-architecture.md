# 02 Architecture

## Services

1. `frontend-web` (TypeScript + Vite)
- Repo owner setup UI.
- Contributor gate UI.
- Wallet connect + signing UX.

2. `backend-api` (Rust)
- GitHub OAuth.
- Repo config + whitelist APIs.
- Wallet link/unlink APIs.
- PR challenge and verification logic.
- On-chain stake checks.
- Internal APIs for bot worker.

3. `bot-worker` (TypeScript)
- Receives GitHub webhooks.
- Calls backend internal decision APIs.
- Posts PR comments and closes PRs via GitHub App token.

4. `postgres`
- Source of truth for users, configs, challenges, audit logs.

5. `staking-contract` (Solidity on Base)
- Custody-less ETH lock contract used for gate eligibility.

## Data/control flow

1. PR opened
- GitHub sends `pull_request` webhook to bot worker.
- Bot forwards normalized PR event to backend.
- Backend returns decision (`REQUIRE_STAKE`, `EXEMPT`, etc.).
- Bot comments on PR with gate URL when stake is required.
- Backend schedules deadline job for 30 minutes.

2. Contributor verification
- User opens gate URL and signs in with GitHub.
- User links wallet (if needed).
- Frontend requests typed data for PR confirmation.
- User signs EIP-712 message.
- Backend verifies signature, linkage, nonce, expiry, and active stake.
- Backend marks challenge `VERIFIED`; close job becomes no-op.

3. Deadline close
- Worker executes at deadline.
- If status still `PENDING`, re-check whitelist and status.
- If not exempt, backend triggers bot action to close PR.

## Runtime invariants

- A wallet can be actively linked to only one GitHub account.
- A GitHub account can have only one active wallet link.
- Wallet unlink is blocked if on-chain staked balance is non-zero.
- Challenge validity is scoped to repo + PR number + author + head SHA + expiry.
- Stake must satisfy threshold and lock must still be active.
