import type { ConfirmTypedDataResponse } from '../types';

export const DEFAULT_CONFIRM_TYPES = {
  PRGateConfirmation: [
    { name: 'githubUserId', type: 'uint256' },
    { name: 'githubRepoId', type: 'uint256' },
    { name: 'pullRequestNumber', type: 'uint256' },
    { name: 'headSha', type: 'string' },
    { name: 'challengeId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' }
  ]
} as const;

function isHex(value: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(value);
}

export function uuidToBigInt(value: string): bigint {
  const normalized = value.replaceAll('-', '');
  return BigInt(`0x${normalized}`);
}

export function normalizeChallengeId(value: string): `0x${string}` {
  if (isHex(value) && value.length === 66) {
    return value as `0x${string}`;
  }

  const normalized = value.replaceAll('-', '');
  return `0x${normalized.padStart(64, '0')}`;
}

export function normalizeNonce(value: string): bigint {
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }

  if (isHex(value)) {
    return BigInt(value);
  }

  return uuidToBigInt(value);
}

export function normalizeConfirmTypedData(typed: ConfirmTypedDataResponse) {
  const primaryType = typed.primaryType ?? typed.primary_type ?? 'PRGateConfirmation';

  return {
    domain: typed.domain,
    types: typed.types ?? DEFAULT_CONFIRM_TYPES,
    primaryType,
    message: {
      githubUserId: BigInt(typed.message.githubUserId),
      githubRepoId: BigInt(typed.message.githubRepoId),
      pullRequestNumber: BigInt(typed.message.pullRequestNumber),
      headSha: typed.message.headSha,
      challengeId: normalizeChallengeId(typed.message.challengeId),
      nonce: normalizeNonce(typed.message.nonce),
      expiresAt: BigInt(typed.message.expiresAt)
    }
  };
}
