import { describe, expect, it } from 'vitest';
import { formatCountdown, gateFailureMessage, parseGateToken } from './gate-logic';
import type { GateViewResponse } from './types';

function baseGate(overrides: Partial<GateViewResponse> = {}): GateViewResponse {
  return {
    challenge_id: 'id',
    status: 'PENDING',
    deadline_at: '2030-01-01T00:01:30Z',
    is_whitelisted: false,
    challenge_login: 'alice',
    repo_full_name: 'org/repo',
    pull_request_number: 42,
    pull_request_url: 'https://github.com/org/repo/pull/42',
    head_sha: 'abc123abc123abc123abc123abc123abc123abcd',
    linked_wallet: '0x1234',
    has_sufficient_stake: true,
    lock_active: true,
    ...overrides
  };
}

describe('parseGateToken', () => {
  it('extracts token', () => {
    expect(parseGateToken('/g/abc123')).toBe('abc123');
  });

  it('decodes token', () => {
    expect(parseGateToken('/g/a%2Fb')).toBe('a/b');
  });

  it('returns null for non-gate path', () => {
    expect(parseGateToken('/wallet')).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('formats positive countdown', () => {
    const now = new Date('2030-01-01T00:00:00Z').getTime();
    expect(formatCountdown('2030-01-01T00:01:09Z', now)).toBe('01:09');
  });

  it('clamps expired countdown', () => {
    const now = new Date('2030-01-01T00:00:01Z').getTime();
    expect(formatCountdown('2030-01-01T00:00:00Z', now)).toBe('00:00');
  });
});

describe('gateFailureMessage', () => {
  it('returns null when all checks pass', () => {
    expect(gateFailureMessage(baseGate(), { github_user_id: 1, github_login: 'alice', linked_wallet: '0x1234' })).toBeNull();
  });

  it('fails wrong user', () => {
    expect(gateFailureMessage(baseGate(), { github_user_id: 1, github_login: 'bob', linked_wallet: '0x1234' })).toContain('Wrong GitHub account');
  });

  it('fails insufficient stake', () => {
    expect(gateFailureMessage(baseGate({ has_sufficient_stake: false }), { github_user_id: 1, github_login: 'alice', linked_wallet: '0x1234' })).toContain('Insufficient or inactive stake');
  });

  it('fails expired first', () => {
    expect(gateFailureMessage(baseGate({ status: 'EXPIRED' }), { github_user_id: 1, github_login: 'alice', linked_wallet: '0x1234' })).toContain('Challenge expired');
  });
});
