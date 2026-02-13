import { describe, expect, it } from 'vitest';
import { normalizeChallengeId, normalizeConfirmTypedData, normalizeNonce } from './eip712';

describe('eip712 normalize', () => {
  it('normalizes uuid challenge id and nonce', () => {
    const normalized = normalizeConfirmTypedData({
      domain: { name: 'SITG', version: '1', chainId: 8453, verifyingContract: '0x0000000000000000000000000000000000000000' },
      primary_type: 'PRGateConfirmation',
      message: {
        githubUserId: 1,
        githubRepoId: 2,
        pullRequestNumber: 3,
        headSha: 'abc',
        challengeId: '8f8be643-bca1-4f96-b98d-9fbc5c860a4f',
        nonce: 'f7c87a8b-9055-4e58-8b28-7f06ef7b2363',
        expiresAt: 100
      }
    });

    expect(normalized.message.challengeId.startsWith('0x')).toBe(true);
    expect(typeof normalized.message.nonce).toBe('bigint');
  });

  it('accepts bytes32 challenge id', () => {
    const bytes32 = normalizeChallengeId('0x' + 'ab'.repeat(32));
    expect(bytes32.length).toBe(66);
  });

  it('accepts decimal nonce', () => {
    expect(normalizeNonce('42')).toBe(42n);
  });
});
