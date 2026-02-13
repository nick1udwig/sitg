# 07 Frontend Spec (TypeScript + Vite)

## Platform scope

- Desktop web only.
- Mobile is not supported and should show an explicit unsupported message.

## Primary pages

1. Repo owner setup
- Connect/install GitHub App.
- Select repo.
- Configure threshold input mode (`ETH` or `USD`) and value.
- Show computed enforced ETH + current USD estimate.
- Configure `draft_prs_gated` toggle (default `on`).
- Manage whitelist by GitHub login (repo owner only).

2. Contributor gate page (`/g/{gate_token}`)
- Shows PR context and countdown timer.
- Requires GitHub sign-in.
- If not whitelisted and not verified:
- Connect wallet.
- If insufficient stake, show fund + stake actions.
- If sufficient stake and lock active, show sign confirmation action.

3. Wallet link management
- Show linked wallet.
- Allow unlink if and only if on-chain staked balance is zero.

## UX copy requirements

Threshold copy must be explicit:
- "Enforcement is in ETH."
- "USD value is an estimate using spot price at configuration time."

## Wallet flow (MVP)

- Existing wallets only (WalletConnect or injected wallet).
- No embedded passkey wallet in MVP.

## PR confirmation signing

- Fetch typed data from backend.
- Sign via wallet.
- Submit signature to backend.
- Render success state with "PR verified" confirmation.

## Failure states

- Expired challenge (deadline passed).
- Wrong GitHub account for challenge.
- No linked wallet.
- Insufficient or inactive stake.
- Desktop-only blocked state.
