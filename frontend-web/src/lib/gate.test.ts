import { describe, expect, it } from 'vitest';
import { gateBlockingMessage, gateReadyMessage, parseCountdown } from './gate';

describe('parseCountdown', () => {
  it('formats countdown', () => {
    const now = new Date('2030-01-01T00:00:00Z').getTime();
    expect(parseCountdown('2030-01-01T00:01:09Z', now)).toBe('01:09');
  });

  it('clamps expired timer', () => {
    const now = new Date('2030-01-01T00:01:00Z').getTime();
    expect(parseCountdown('2030-01-01T00:00:59Z', now)).toBe('00:00');
  });
});

describe('gateBlockingMessage', () => {
  const gate = {
    challenge_id: 'c',
    status: 'PENDING',
    github_repo_id: 1,
    github_repo_full_name: 'org/repo',
    github_pr_number: 2,
    github_pr_author_id: 3,
    github_pr_author_login: 'alice',
    head_sha: 'abc',
    deadline_at: '2030-01-01T00:00:00Z',
    threshold_wei_snapshot: '1'
  };

  it('requires sign in', () => {
    expect(gateBlockingMessage(gate, null, new Date('2029-01-01T00:00:00Z').getTime())).toContain('Sign in');
  });

  it('rejects wrong user', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 4, github_login: 'bob' }, new Date('2029-01-01T00:00:00Z').getTime())
    ).toContain('Wrong GitHub account');
  });

  it('returns null when allowed', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 3, github_login: 'alice' }, new Date('2029-01-01T00:00:00Z').getTime())
    ).toBeNull();
  });

  it('matches the author by GitHub user ID despite login casing or renames', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 3, github_login: 'Alice-Renamed' }, new Date('2029-01-01T00:00:00Z').getTime())
    ).toBeNull();
  });

  it('blocks pending challenges after their deadline', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 3, github_login: 'alice' }, new Date('2030-01-01T00:00:01Z').getTime())
    ).toBe('This challenge has expired.');
  });

  it('explains canceled and unknown terminal statuses', () => {
    const me = { id: 'u', github_user_id: 3, github_login: 'alice' };
    const now = new Date('2029-01-01T00:00:00Z').getTime();

    expect(gateBlockingMessage({ ...gate, status: 'CANCELED' }, me, now)).toContain('canceled');
    expect(gateBlockingMessage({ ...gate, status: 'FUTURE_STATUS' }, me, now)).toBe(
      'This challenge is no longer active.'
    );
  });

  it('describes successful terminal statuses without inviting another verification', () => {
    expect(gateBlockingMessage({ ...gate, status: 'EXEMPT' }, null)).toBeNull();
    expect(gateReadyMessage({ ...gate, status: 'EXEMPT' })).toContain('no verification');
    expect(gateReadyMessage({ ...gate, status: 'VERIFIED' })).toContain('verified');
  });
});
