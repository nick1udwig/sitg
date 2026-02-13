# 01 Overview

## Problem

Open-source maintainers face high inbound PR spam. Reviewing low-signal PRs consumes maintainer time and slows real contributions.

## Product

Stake-to-Contribute is a SaaS + GitHub App that gates PRs by requiring contributors to hold active ETH stake in a shared staking contract on Base.

## Core behavior

1. Repo owner installs GitHub App and configures minimum stake requirement.
2. Contributor opens PR.
3. Bot comments with a gate link and 30-minute deadline.
4. Contributor signs in on SaaS, links wallet, and signs PR confirmation.
5. Backend validates signature + on-chain stake.
6. If valid, PR is marked verified; if not valid by deadline, bot closes PR.

## Key product rules

- Stake is global per wallet, but repo threshold is per repo.
- Enforcement is always in ETH.
- Repo owner may set threshold using ETH input or USD input.
- If USD input is used, backend converts once using CoinGecko spot and stores ETH.
- CoinGecko spot cache TTL is 5 minutes; if live fetch fails, last cached spot is used.
- Threshold changes apply only to new PR challenges.
- Whitelisted GitHub accounts bypass staking requirement.
- Draft PR gating is per-repo configurable, default `true`.
- Strict close for MVP. No auto-reopen in MVP.
- Verification is point-in-time for a PR challenge once accepted.
- Public repos only in MVP.
- Global launch in MVP; sanctions/geoblocking controls are deferred.
- Desktop only.

## Non-goals (MVP)

- Embedded passkey wallet.
- Mobile support.
- PR reopen request flow.
- Sanctions/geoblocking implementation.
- Private repository support.
