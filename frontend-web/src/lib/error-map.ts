import type { ApiError } from '../types';

const CODE_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'You need to sign in with GitHub first.',
  WALLET_HAS_STAKE: 'Cannot unlink wallet while stake is non-zero.',
  NOT_FOUND: 'Resource not found.',
  PRICE_UNAVAILABLE: 'Price quote unavailable. Try again shortly.',
  CHALLENGE_EXPIRED: 'Challenge expired. Open a fresh gate URL from the PR comment.',
  CHALLENGE_NOT_PENDING: 'Challenge is no longer pending.',
  WALLET_LINK_CHALLENGE_INVALID: 'Wallet link challenge expired or already used. Retry linking.',
  WALLET_ALREADY_LINKED: 'This wallet is already linked to another GitHub account.',
  NONCE_INVALID: 'Confirmation nonce is invalid or expired. Reload and retry.',
  VALIDATION_ERROR: 'Please check your inputs and try again.'
};

export function toUserMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const apiError = error as ApiError;
    if (
      apiError.code === 'VALIDATION_ERROR'
      && typeof apiError.message === 'string'
      && apiError.message.toLowerCase().includes('github app is not installed')
    ) {
      return 'GitHub App is not installed for this repo owner yet. Install it, then try again.';
    }
    if (apiError.code && CODE_MESSAGES[apiError.code]) {
      return CODE_MESSAGES[apiError.code];
    }

    if (apiError.message) {
      return apiError.message;
    }
  }

  return 'Unexpected error.';
}
