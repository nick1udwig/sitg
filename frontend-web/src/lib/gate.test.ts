import { describe, expect, it } from 'vitest';
import { gateBlockingMessage, parseCountdown } from './gate';

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
    expect(gateBlockingMessage(gate, null)).toContain('Sign in');
  });

  it('rejects wrong user', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 4, github_login: 'bob' })
    ).toContain('Wrong GitHub account');
  });

  it('returns null when allowed', () => {
    expect(
      gateBlockingMessage(gate, { id: 'u', github_user_id: 3, github_login: 'alice' })
    ).toBeNull();
  });
});
