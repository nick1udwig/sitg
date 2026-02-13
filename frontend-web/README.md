# frontend-web

React + Vite frontend for SITG MVP.

## Features implemented

- Owner setup page with sign-in, GitHub App install CTA, repo picker, config save, whitelist save, and bot client/key/installation binding management.
- Contributor gate at `/g/:gateToken` with countdown, wallet linking, typed-data confirmation.
- Wallet management page with link/unlink actions.
- Desktop-only gate.
- Injected wallet + WalletConnect support via RainbowKit + wagmi (Base chain).
- Centralized UI state, busy-state controls, notice stack, error boundary.
- Accessibility pass: live regions, keyboard focus styling, explicit labels.

## Backend contract alignment (current)

This frontend matches the current Rust backend API responses in `backend-api/src/models/api.rs` and routes in `backend-api/src/routes/mod.rs`.

Optional integration endpoints supported with graceful fallback (UI still works if absent):

- `GET /api/v1/repos`
- `GET /api/v1/github/installations/status?repo_id=...`
- `GET /api/v1/wallet/link`
- `GET /api/v1/stake/status?wallet=...`

Current backend limitation still exposed in UI:

- `GET /api/v1/me` does not include linked wallet address.

## Environment

Copy `.env.example` to `.env` and set values:

- `VITE_API_BASE_URL`: optional API origin prefix.
- `VITE_WALLETCONNECT_PROJECT_ID`: required for WalletConnect provider support.
- `VITE_GITHUB_APP_INSTALL_URL`: optional GitHub App install URL button target.
- `VITE_STAKE_URL`: optional stake page URL used for Fund + Stake CTA on gate.

## Commands

- `npm install`
- `npm run dev`
- `npm run test`
- `npm run typecheck`
- `npm run build`

## Testing

- Unit + integration tests run with Vitest + jsdom.
- API client tests use mocked `fetch`.
- State, error mapping, EIP-712 normalization, and gate page flow are covered.
