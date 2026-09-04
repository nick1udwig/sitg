import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmWalletLink,
  deleteWhitelistEntry,
  getInstallStatus,
  getMe,
  getOwnedRepos,
  getStakeStatus,
  getStakingConfig,
  getWalletLinkStatus,
  getWhitelist,
  githubSignIn,
  putRepoConfig,
  requestWalletLinkChallenge,
  resolveWhitelistLogins,
  submitGateConfirmation,
  unlinkWallet
} from './api';

function mockJsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text
  } as Response;
}

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for unauthenticated me', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'unauthenticated' } })
    );

    const me = await getMe();
    expect(me).toBeNull();
  });

  it('surfaces me endpoint failures instead of treating them as signed out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'database unavailable' } })
    );

    await expect(getMe()).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'database unavailable'
    });
  });

  it('starts GitHub sign-in without a state-creating preflight request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await githubSignIn('https://sitg.io/owner?tab=setup');

    expect(fetchSpy).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('sends wallet link confirm payload', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJsonResponse(200, { wallet_address: '0xabc', linked: true }));

    await confirmWalletLink({ nonce: 'n', wallet_address: '0xabc', signature: '0xsig' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toContain('wallet_address');
  });

  it('handles 204 endpoints', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, status: 204 } as Response);
    await expect(unlinkWallet()).resolves.toBeUndefined();
  });

  it('returns challenge payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(200, {
        nonce: '123',
        expires_at: '2026-01-01T00:00:00Z',
        message: 'Sign me'
      })
    );

    const result = await requestWalletLinkChallenge();
    expect(result.nonce).toBe('123');
  });

  it('loads the authoritative staking configuration', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(200, {
        chain_id: 8453,
        contract_address: '0x1111111111111111111111111111111111111111'
      })
    );

    const config = await getStakingConfig();
    expect(config.chain_id).toBe(8453);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/v1/staking/config');
  });

  it('submits gate signature', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse(200, { status: 'VERIFIED' }));

    const result = await submitGateConfirmation('token', '0xsig');
    expect(result.status).toBe('VERIFIED');
  });

  it('sends repo config payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(200, {
        github_repo_id: 1,
        threshold: {
          wei: '1',
          eth: '0.1',
          usd_estimate: '300',
          input_mode: 'ETH',
          input_value: '0.1',
          spot_price_usd: '3000',
          spot_source: 'coingecko',
          spot_at: '2026-02-13T00:00:00Z',
          spot_from_cache: false,
          spot_quote_id: null,
          message: 'Enforced in ETH. USD is an estimate.'
        },
        draft_prs_gated: true
      })
    );

    await putRepoConfig('1', { input_mode: 'ETH', input_value: '0.1', draft_prs_gated: true });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).method).toBe('PUT');
    expect((init as RequestInit).body).toContain('input_mode');
  });

  it('resolves whitelist logins', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(200, { resolved: [{ github_user_id: 1, github_login: 'alice' }], unresolved: [] })
    );
    const result = await resolveWhitelistLogins('1', ['alice']);
    expect(result.resolved[0].github_login).toBe('alice');
  });

  it('lists and deletes whitelist entries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse(200, [{ github_user_id: 1, github_login: 'alice' }])
    );
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await expect(getWhitelist('9')).resolves.toEqual([
      { github_user_id: 1, github_login: 'alice' }
    ]);
    await expect(deleteWhitelistEntry('9', 1)).resolves.toBeUndefined();

    expect(fetchSpy.mock.calls[0][0]).toContain('/api/v1/repos/9/whitelist');
    expect(fetchSpy.mock.calls[1][0]).toContain('/api/v1/repos/9/whitelist/1');
    expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('returns null for optional not-found endpoints', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } }));
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } }));
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } }));
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } }));

    await expect(getOwnedRepos()).resolves.toBeNull();
    await expect(getInstallStatus('1')).resolves.toBeNull();
    await expect(getWalletLinkStatus()).resolves.toBeNull();
    await expect(getStakeStatus('0xabc')).resolves.toBeNull();
  });

  it('normalizes conflict reason code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(409, { error: { code: 'CONFLICT', message: 'conflict: CHALLENGE_EXPIRED' } })
    );
    await expect(submitGateConfirmation('token', 'sig')).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });

  it('uses repo github app status endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse(200, {
        installed: true,
        installation_id: 123,
        installation_account_login: 'owner',
        installation_account_type: 'User',
        repo_connected: true
      })
    );

    const status = await getInstallStatus('999');
    expect(status?.installation_id).toBe(123);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/v1/repos/999/github-app-status');
  });
});
