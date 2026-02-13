import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signMessageWithInjectedWallet, signTypedDataWithInjectedWallet } from './wallet';

describe('wallet helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('signs message via personal_sign', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(['0xabc'])
      .mockResolvedValueOnce('0xsig-message');
    (window as Window & { ethereum?: { request: typeof request } }).ethereum = { request };

    const signature = await signMessageWithInjectedWallet('hello');

    expect(signature).toBe('0xsig-message');
    expect(request).toHaveBeenNthCalledWith(1, { method: 'eth_requestAccounts' });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'personal_sign',
      params: ['hello', '0xabc']
    });
  });

  it('signs typed data via eth_signTypedData_v4', async () => {
    const request = vi.fn().mockResolvedValueOnce(['0xabc']).mockResolvedValueOnce('0xsig-typed');
    (window as Window & { ethereum?: { request: typeof request } }).ethereum = { request };

    const typed = {
      domain: { name: 'StakeToContribute' },
      types: { PRGateConfirmation: [] },
      message: { nonce: 1 }
    };

    const signature = await signTypedDataWithInjectedWallet(typed);

    expect(signature).toBe('0xsig-typed');
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'eth_signTypedData_v4',
      params: ['0xabc', JSON.stringify(typed)]
    });
  });

  it('errors when wallet not injected', async () => {
    (window as Window & { ethereum?: undefined }).ethereum = undefined;

    await expect(signMessageWithInjectedWallet('hi')).rejects.toThrow('No injected wallet found');
  });
});
