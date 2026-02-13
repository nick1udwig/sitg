import { describe, expect, it } from 'vitest';
import { toUserMessage } from './error-map';

describe('toUserMessage', () => {
  it('maps known code', () => {
    expect(toUserMessage({ code: 'WALLET_HAS_STAKE', message: 'x' })).toContain('stake');
  });

  it('falls back to raw message', () => {
    expect(toUserMessage({ message: 'raw problem' })).toBe('raw problem');
  });
});
