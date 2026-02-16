import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useAppState } from '../state';

const apiMocks = vi.hoisted(() => ({
  getInstallStatus: vi.fn(),
  getOwnedRepos: vi.fn(),
  getRepoConfig: vi.fn(),
  githubSignIn: vi.fn(),
  logout: vi.fn(),
  putRepoConfig: vi.fn(),
  putWhitelist: vi.fn(),
  resolveWhitelistLogins: vi.fn()
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<object>('../api');
  return {
    ...actual,
    ...apiMocks
  };
});

import { OwnerPage } from './OwnerPage';

function SeedOwner() {
  const { setMe } = useAppState();

  useEffect(() => {
    setMe({
      id: 'owner-user',
      github_user_id: 1001,
      github_login: 'owner'
    });
  }, [setMe]);

  return null;
}

function renderPage() {
  return render(
    <AppStateProvider>
      <SeedOwner />
      <OwnerPage />
    </AppStateProvider>
  );
}

describe('OwnerPage flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    apiMocks.getOwnedRepos.mockResolvedValue([
      { id: 999, full_name: 'owner/repo' },
      { id: 888, full_name: 'owner/other' }
    ]);
    apiMocks.getRepoConfig.mockResolvedValue({
      github_repo_id: 999,
      threshold: {
        wei: '1000000000000000000',
        eth: '1',
        usd_estimate: '2500',
        input_mode: 'ETH',
        input_value: '1',
        spot_price_usd: '2500',
        spot_source: 'coingecko',
        spot_at: '2026-02-13T00:00:00Z',
        spot_from_cache: false,
        spot_quote_id: '00000000-0000-0000-0000-000000000004',
        message: 'Enforced in ETH. USD is an estimate.'
      },
      draft_prs_gated: true
    });
    apiMocks.getInstallStatus.mockResolvedValue({
      installed: true,
      installation_id: 123,
      installation_account_login: 'owner',
      installation_account_type: 'User',
      repo_connected: true
    });
    apiMocks.putRepoConfig.mockResolvedValue({
      github_repo_id: 999,
      threshold: {
        wei: '120000000000000000',
        eth: '0.12',
        usd_estimate: '300',
        input_mode: 'ETH',
        input_value: '0.12',
        spot_price_usd: '2500',
        spot_source: 'coingecko',
        spot_at: '2026-02-13T00:00:00Z',
        spot_from_cache: false,
        spot_quote_id: '00000000-0000-0000-0000-000000000004',
        message: 'Enforced in ETH. USD is an estimate.'
      },
      draft_prs_gated: false
    });
    apiMocks.resolveWhitelistLogins.mockResolvedValue({
      resolved: [{ github_user_id: 3003, github_login: 'alice' }],
      unresolved: ['ghost']
    });
    apiMocks.putWhitelist.mockResolvedValue(undefined);
    apiMocks.logout.mockResolvedValue(undefined);
  });

  it('covers repository config, whitelist, and repo info github app metadata', async () => {
    const user = userEvent.setup();
    renderPage();

    // Wait for sidebar repos to load
    const repoButton = await screen.findByRole('button', { name: 'owner/repo' });
    await user.click(repoButton);

    await waitFor(() => {
      expect(apiMocks.getRepoConfig).toHaveBeenCalledWith('999');
      expect(apiMocks.getInstallStatus).toHaveBeenCalledWith('999');
    });
    expect(screen.getByText('123')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText('User')).toBeTruthy();

    // Navigate to Threshold & Whitelist tab
    await user.click(screen.getByRole('button', { name: 'Threshold & Whitelist' }));

    await user.selectOptions(screen.getByLabelText('Input mode'), 'ETH');
    await user.clear(screen.getByLabelText('Value'));
    await user.type(screen.getByLabelText('Value'), '0.12');
    await user.selectOptions(screen.getByLabelText('Draft gated'), 'false');
    await user.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => {
      expect(apiMocks.putRepoConfig).toHaveBeenCalledWith('999', {
        input_mode: 'ETH',
        input_value: '0.12',
        draft_prs_gated: false
      });
    });

    await user.type(screen.getByLabelText('GitHub logins (comma separated)'), 'alice, ghost');
    await user.click(screen.getByRole('button', { name: 'Resolve + Save Whitelist' }));

    await waitFor(() => {
      expect(apiMocks.resolveWhitelistLogins).toHaveBeenCalledWith('999', ['alice', 'ghost']);
      expect(apiMocks.putWhitelist).toHaveBeenCalledWith('999', [{ github_user_id: 3003, github_login: 'alice' }]);
    });

    await user.click(screen.getByRole('button', { name: 'Repo Info' }));
    expect(screen.getByRole('link', { name: 'Install App' })).toBeTruthy();
  });

  it('allows adding a repo by full name when repo id is left empty', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'owner/repo' });
    const addRepoButtons = screen.getAllByRole('button', { name: 'Add repository' });
    await user.click(addRepoButtons[addRepoButtons.length - 1]);

    const fullNameInputs = screen.getAllByLabelText('Full name');
    await user.type(fullNameInputs[fullNameInputs.length - 1], 'owner/repo');

    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    await user.click(addButtons[addButtons.length - 1]);

    await waitFor(() => {
      expect(apiMocks.getRepoConfig).toHaveBeenCalledWith('999');
      expect(apiMocks.getInstallStatus).toHaveBeenCalledWith('999');
    });
  });

  it('recovers from stale selected repo id in local storage', async () => {
    const user = userEvent.setup();
    localStorage.setItem('sitg.selectedRepo', JSON.stringify({ id: '1', fullName: 'owner/unknown' }));
    localStorage.setItem('sitg.recentRepos', JSON.stringify([{ id: '1', fullName: 'owner/unknown' }]));

    renderPage();
    await screen.findAllByRole('button', { name: 'owner/repo' });

    await waitFor(() => {
      expect(apiMocks.getRepoConfig).toHaveBeenCalledWith('999');
      expect(apiMocks.getInstallStatus).toHaveBeenCalledWith('999');
    });

    expect(apiMocks.getRepoConfig).not.toHaveBeenCalledWith('1');

    const thresholdTabs = screen.getAllByRole('button', { name: 'Threshold & Whitelist' });
    await user.click(thresholdTabs[thresholdTabs.length - 1]);
    const saveButtons = screen.getAllByRole('button', { name: 'Save Config' });
    await user.click(saveButtons[saveButtons.length - 1]);
    await waitFor(() => {
      expect(apiMocks.putRepoConfig).toHaveBeenCalledWith('999', {
        input_mode: 'ETH',
        input_value: '1',
        draft_prs_gated: true
      });
    });
  });
});
