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

export function gateBlockingMessage(gate: GateResponse, me: MeResponse | null): string | null {
  if (gate.status === 'TIMED_OUT_CLOSED') {
    return 'This challenge expired and the PR was closed.';
  }

  if (gate.status === 'VERIFIED') {
    return null;
  }

  if (!me) {
    return 'Sign in with GitHub to continue.';
  }

  if (me.github_login !== gate.github_pr_author_login) {
    return 'Wrong GitHub account for this challenge.';
  }

  return null;
}
