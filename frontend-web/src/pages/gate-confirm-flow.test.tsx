import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useAppState } from '../state';

const wagmiMocks = vi.hoisted(() => ({
  account: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 1 },
  signMessageAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  switchChainAsync: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  confirmWalletLink: vi.fn(),
  getConfirmTypedData: vi.fn(),
  getGate: vi.fn(),
  getStakeStatus: vi.fn(),
  githubSignIn: vi.fn(),
  requestWalletLinkChallenge: vi.fn(),
  submitGateConfirmation: vi.fn()
}));

vi.mock('wagmi', () => ({
  useAccount: () => wagmiMocks.account,
  useSignMessage: () => ({ signMessageAsync: wagmiMocks.signMessageAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
  useSwitchChain: () => ({ switchChainAsync: wagmiMocks.switchChainAsync })
}));

vi.mock('../lib/wagmi', () => ({
  SUPPORTED_CHAIN_ID: 8453
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<object>('../api');
  return {
    ...actual,
    ...apiMocks
  };
});

import { GatePage } from './GatePage';

function SeedMe({ login }: { login: string }) {
  const { setMe } = useAppState();

  useEffect(() => {
    setMe({
      id: `user-${login}`,
      github_user_id: login === 'contrib' ? 2002 : 9999,
      github_login: login
    });
  }, [login, setMe]);

  return null;
}

function renderGate(login: string) {
  return render(
    <AppStateProvider>
      <SeedMe login={login} />
      <MemoryRouter initialEntries={['/g/token-1']}>
        <Routes>
          <Route path="/g/:gateToken" element={<GatePage />} />
        </Routes>
      </MemoryRouter>
    </AppStateProvider>
  );
}

describe('GatePage confirmation flow', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    wagmiMocks.account = { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 1 };
    wagmiMocks.switchChainAsync.mockResolvedValue(undefined);
    wagmiMocks.signMessageAsync.mockResolvedValue('0xwallet-sig');
    wagmiMocks.signTypedDataAsync.mockResolvedValue('0xconfirm-sig');

    apiMocks.getGate
      .mockResolvedValueOnce({
        challenge_id: '2c6dc47f-00ea-401d-8d96-13794ca39f35',
        status: 'PENDING',
        github_repo_id: 999,
        github_repo_full_name: 'owner/repo',
        github_pr_number: 42,
        github_pr_author_id: 2002,
        github_pr_author_login: 'contrib',
        head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        deadline_at: '2099-01-01T00:10:00Z',
        threshold_wei_snapshot: '1000000000000000000'
      })
      .mockResolvedValueOnce({
        challenge_id: '2c6dc47f-00ea-401d-8d96-13794ca39f35',
        status: 'VERIFIED',
        github_repo_id: 999,
        github_repo_full_name: 'owner/repo',
        github_pr_number: 42,
        github_pr_author_id: 2002,
        github_pr_author_login: 'contrib',
        head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        deadline_at: '2099-01-01T00:10:00Z',
        threshold_wei_snapshot: '1000000000000000000'
      });
    apiMocks.getStakeStatus.mockResolvedValue({
      staked_balance_wei: '2000000000000000000',
      unlock_time: '2099-01-02T00:00:00Z',
      lock_active: true
    });
    apiMocks.requestWalletLinkChallenge.mockResolvedValue({
      nonce: 'nonce-1',
      expires_at: '2099-01-01T00:09:00Z',
      message: 'link challenge'
    });
    apiMocks.confirmWalletLink.mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      linked: true
    });
    apiMocks.getConfirmTypedData.mockResolvedValue({
      domain: {
        name: 'SITG',
        version: '1',
        chainId: 8453,
        verifyingContract: '0x0000000000000000000000000000000000000001'
      },
      primaryType: 'PRGateConfirmation',
      types: {
        PRGateConfirmation: [
          { name: 'githubUserId', type: 'uint256' },
          { name: 'githubRepoId', type: 'uint256' },
          { name: 'pullRequestNumber', type: 'uint256' },
          { name: 'headSha', type: 'string' },
          { name: 'challengeId', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiresAt', type: 'uint256' }
        ]
      },
      message: {
        githubUserId: 2002,
        githubRepoId: 999,
        pullRequestNumber: 42,
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        challengeId: '0x000000000000000000000000000000002c6dc47f00ea401d8d9613794ca39f35',
        nonce: '1',
        expiresAt: 4070908800
      }
    });
    apiMocks.submitGateConfirmation.mockResolvedValue({ status: 'VERIFIED' });
    apiMocks.githubSignIn.mockImplementation(() => {});
  });

  it('links wallet then submits typed-data confirmation', async () => {
    const user = userEvent.setup();
    renderGate('contrib');

    expect(await screen.findByText(/PR Stake Gate/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Link' }));

    await waitFor(() => {
      expect(wagmiMocks.switchChainAsync).toHaveBeenCalledWith({ chainId: 8453 });
      expect(apiMocks.requestWalletLinkChallenge).toHaveBeenCalledTimes(1);
      expect(apiMocks.confirmWalletLink).toHaveBeenCalledWith({
        nonce: 'nonce-1',
        wallet_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        signature: '0xwallet-sig'
      });
    });

    await user.click(screen.getByRole('button', { name: 'Sign' }));
    await waitFor(() => {
      expect(apiMocks.getConfirmTypedData).toHaveBeenCalledWith('token-1');
      expect(wagmiMocks.signTypedDataAsync).toHaveBeenCalledTimes(1);
      expect(apiMocks.submitGateConfirmation).toHaveBeenCalledWith('token-1', '0xconfirm-sig');
      expect(apiMocks.getGate).toHaveBeenCalledTimes(2);
    });
  });

  it('blocks action buttons when signed into the wrong GitHub account', async () => {
    renderGate('other-user');

    expect(await screen.findByText('Wrong GitHub account for this challenge.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Sign' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
