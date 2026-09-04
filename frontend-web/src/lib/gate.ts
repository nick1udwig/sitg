import type { GateResponse, MeResponse } from '../types';

export function parseCountdown(deadlineAt: string, now = Date.now()): string {
  const leftMs = new Date(deadlineAt).getTime() - now;
  if (leftMs <= 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(leftMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function gateBlockingMessage(gate: GateResponse, me: MeResponse | null, now = Date.now()): string | null {
  switch (gate.status) {
    case 'VERIFIED':
    case 'EXEMPT':
      return null;
    case 'TIMED_OUT_CLOSED':
      return 'This challenge expired and the PR was closed.';
    case 'CANCELED':
      return 'This challenge was canceled because the pull request changed or closed.';
    case 'PENDING':
      break;
    default:
      return 'This challenge is no longer active.';
  }

  if (new Date(gate.deadline_at).getTime() <= now) {
    return 'This challenge has expired.';
  }

  if (!me) {
    return 'Sign in with GitHub to continue.';
  }

  if (me.github_user_id !== gate.github_pr_author_id) {
    return 'Wrong GitHub account for this challenge.';
  }

  return null;
}

export function gateReadyMessage(gate: GateResponse): string {
  if (gate.status === 'VERIFIED') {
    return 'This pull request has been verified.';
  }
  if (gate.status === 'EXEMPT') {
    return 'This contributor is exempt; no verification is required.';
  }
  return 'Ready for verification.';
}
