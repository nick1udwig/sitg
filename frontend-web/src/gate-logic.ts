import type { GateViewResponse, MeResponse } from './types';

export function parseGateToken(path: string): string | null {
  const match = path.match(/^\/g\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function formatCountdown(deadlineAt: string, now = Date.now()): string {
  const leftMs = new Date(deadlineAt).getTime() - now;
  if (leftMs <= 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(leftMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function gateFailureMessage(gate: GateViewResponse, me: MeResponse | null): string | null {
  if (gate.status === 'EXPIRED') {
    return 'Challenge expired. Deadline has passed.';
  }

  if (!me) {
    return 'Sign in with GitHub to continue.';
  }

  if (me.github_login !== gate.challenge_login) {
    return 'Wrong GitHub account for challenge. Switch account and retry.';
  }

  if (!gate.linked_wallet) {
    return 'No linked wallet. Link a wallet before confirming this PR.';
  }

  if (!gate.has_sufficient_stake || !gate.lock_active) {
    return 'Insufficient or inactive stake. Fund and stake before confirming.';
  }

  return null;
}
