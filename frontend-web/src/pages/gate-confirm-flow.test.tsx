import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useAppState } from '../state';

const wagmiMocks = vi.hoisted(() => ({
  account: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 1 },
  publicClient: { waitForTransactionReceipt: vi.fn() },
  signMessageAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  writeContractAsync: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  confirmWalletLink: vi.fn(),
  getConfirmTypedData: vi.fn(),
  getGate: vi.fn(),
  getStakeStatus: vi.fn(),
  getStakingConfig: vi.fn(),
  getWalletLinkStatus: vi.fn(),
  githubSignIn: vi.fn(),
  requestWalletLinkChallenge: vi.fn(),
  submitGateConfirmation: vi.fn()
}));

vi.mock('wagmi', () => ({
  useAccount: () => wagmiMocks.account,
  usePublicClient: () => wagmiMocks.publicClient,
  useSignMessage: () => ({ signMessageAsync: wagmiMocks.signMessageAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: wagmiMocks.signTypedDataAsync }),
  useSwitchChain: () => ({ switchChainAsync: wagmiMocks.switchChainAsync }),
  useWriteContract: () => ({ writeContractAsync: wagmiMocks.writeContractAsync })
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
    wagmiMocks.publicClient.waitForTransactionReceipt.mockReset();
    wagmiMocks.writeContractAsync.mockReset();
    wagmiMocks.switchChainAsync.mockResolvedValue(undefined);
    wagmiMocks.signMessageAsync.mockResolvedValue('0xwallet-sig');
    wagmiMocks.signTypedDataAsync.mockResolvedValue('0xconfirm-sig');

    apiMocks.getGate
      .mockReset()
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
    apiMocks.getStakeStatus.mockReset().mockResolvedValue({
      staked_balance_wei: '2000000000000000000',
      unlock_time: '2099-01-02T00:00:00Z',
      lock_active: true
    });
    apiMocks.getStakingConfig.mockReset().mockResolvedValue({
      chain_id: 8453,
      contract_address: '0x0000000000000000000000000000000000000001'
    });
    apiMocks.getWalletLinkStatus
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        chain_id: 8453,
        linked_at: '2099-01-01T00:00:00Z'
      });
    apiMocks.requestWalletLinkChallenge.mockReset().mockResolvedValue({
      nonce: 'nonce-1',
      expires_at: '2099-01-01T00:09:00Z',
      message: 'link challenge'
    });
    apiMocks.confirmWalletLink.mockReset().mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      linked: true
    });
    apiMocks.getConfirmTypedData.mockReset().mockResolvedValue({
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
    apiMocks.submitGateConfirmation.mockReset().mockResolvedValue({ status: 'VERIFIED' });
    apiMocks.githubSignIn.mockReset().mockImplementation(() => {});
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

  it('renews an expired lock without sending more ETH', async () => {
    wagmiMocks.account = { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 8453 };
    apiMocks.getWalletLinkStatus.mockReset();
    apiMocks.getWalletLinkStatus.mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      chain_id: 8453,
      linked_at: '2026-01-01T00:00:00Z'
    });
    apiMocks.getStakeStatus.mockReset();
    apiMocks.getStakeStatus.mockImplementation(async () => {
      if (wagmiMocks.writeContractAsync.mock.calls.length === 0) {
        return {
          staked_balance_wei: '2000000000000000000',
          unlock_time: '2020-01-01T00:00:00Z',
          lock_active: false
        };
      }
      return {
        staked_balance_wei: '2000000000000000000',
        unlock_time: '2099-01-02T00:00:00Z',
        lock_active: true
      };
    });
    wagmiMocks.writeContractAsync.mockResolvedValue('0xstake-hash');
    wagmiMocks.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    renderGate('contrib');
    await waitFor(() => expect(apiMocks.getStakeStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Renew lock' }));

    await waitFor(() => {
      expect(wagmiMocks.writeContractAsync).toHaveBeenCalledWith({
        address: '0x0000000000000000000000000000000000000001',
        abi: expect.any(Array),
        functionName: 'stake',
        value: 0n
      });
      expect(screen.getByRole('button', { name: 'Staked' })).toBeTruthy();
    });
  });

  it('refuses to sign typed data for a different staking contract', async () => {
    apiMocks.getWalletLinkStatus.mockReset();
    apiMocks.getWalletLinkStatus.mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      chain_id: 8453,
      linked_at: '2026-01-01T00:00:00Z'
    });
    const matchingTypedData = await apiMocks.getConfirmTypedData();
    apiMocks.getConfirmTypedData.mockClear();
    apiMocks.getConfirmTypedData.mockResolvedValueOnce({
      ...matchingTypedData,
      domain: {
        name: 'SITG',
        version: '1',
        chainId: 8453,
        verifyingContract: '0x2222222222222222222222222222222222222222'
      }
    });

    const user = userEvent.setup();
    renderGate('contrib');
    await user.click(await screen.findByRole('button', { name: 'Sign' }));

    await waitFor(() => expect(apiMocks.getConfirmTypedData).toHaveBeenCalled());
    expect(wagmiMocks.signTypedDataAsync).not.toHaveBeenCalled();
    expect(apiMocks.submitGateConfirmation).not.toHaveBeenCalled();
  });
});
