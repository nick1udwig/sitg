import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStateProvider, useAppState } from '../state';

const wagmiMocks = vi.hoisted(() => ({
  account: { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 1 },
  publicClient: { waitForTransactionReceipt: vi.fn() },
  signMessageAsync: vi.fn(),
  switchChainAsync: vi.fn(),
  writeContractAsync: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  confirmWalletLink: vi.fn(),
  getStakeStatus: vi.fn(),
  getStakingConfig: vi.fn(),
  getWalletLinkStatus: vi.fn(),
  githubSignIn: vi.fn(),
  requestWalletLinkChallenge: vi.fn(),
  unlinkWallet: vi.fn()
}));

vi.mock('wagmi', () => ({
  useAccount: () => wagmiMocks.account,
  usePublicClient: () => wagmiMocks.publicClient,
  useSignMessage: () => ({ signMessageAsync: wagmiMocks.signMessageAsync }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
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

import { ContributorPage } from './ContributorPage';

function SeedUser() {
  const { setMe } = useAppState();

  useEffect(() => {
    setMe({
      id: 'contrib-user',
      github_user_id: 2002,
      github_login: 'contrib'
    });
  }, [setMe]);

  return null;
}

function renderAuthedContributorPage() {
  return render(
    <AppStateProvider>
      <SeedUser />
      <ContributorPage />
    </AppStateProvider>
  );
}

describe('ContributorPage flow', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    wagmiMocks.account = { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', chainId: 1 };
    wagmiMocks.signMessageAsync.mockResolvedValue('0xsigned-message');
    wagmiMocks.switchChainAsync.mockResolvedValue(undefined);
    wagmiMocks.writeContractAsync.mockResolvedValue('0xwithdraw-hash');
    wagmiMocks.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    apiMocks.getStakingConfig.mockResolvedValue({
      chain_id: 8453,
      contract_address: '0x1111111111111111111111111111111111111111'
    });
    apiMocks.getStakeStatus.mockResolvedValue({
      staked_balance_wei: '0',
      unlock_time: '1970-01-01T00:00:00Z',
      lock_active: false
    });

    apiMocks.getWalletLinkStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
        chain_id: 8453,
        linked_at: '2026-02-13T00:00:00Z'
      });
    apiMocks.requestWalletLinkChallenge.mockResolvedValue({
      nonce: 'nonce-1',
      expires_at: '2026-02-13T00:10:00Z',
      message: 'Sign me'
    });
    apiMocks.confirmWalletLink.mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      linked: true
    });
    apiMocks.unlinkWallet.mockResolvedValue(undefined);
    apiMocks.githubSignIn.mockImplementation(() => {});
  });

  it('links and unlinks wallet for authenticated user', async () => {
    const user = userEvent.setup();
    renderAuthedContributorPage();

    expect(await screen.findByText('@contrib')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Link Wallet' }));
    await waitFor(() => {
      expect(wagmiMocks.switchChainAsync).toHaveBeenCalledWith({ chainId: 8453 });
      expect(apiMocks.requestWalletLinkChallenge).toHaveBeenCalledTimes(1);
      expect(wagmiMocks.signMessageAsync).toHaveBeenCalledWith({ message: 'Sign me' });
      expect(apiMocks.confirmWalletLink).toHaveBeenCalledWith({
        nonce: 'nonce-1',
        wallet_address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        signature: '0xsigned-message'
      });
    });

    expect(await screen.findByText('0x7099...79c8')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Unlink Wallet' }));
    await waitFor(() => {
      expect(apiMocks.unlinkWallet).toHaveBeenCalledTimes(1);
    });
  });

  it('shows GitHub sign-in action when unauthenticated', async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider>
        <ContributorPage />
      </AppStateProvider>
    );

    const signIn = screen.getByRole('button', { name: 'Sign in with GitHub' });
    await user.click(signIn);
    expect(apiMocks.githubSignIn).toHaveBeenCalledTimes(1);
  });

  it('withdraws an unlocked stake from the configured contract', async () => {
    apiMocks.getWalletLinkStatus.mockReset();
    apiMocks.getWalletLinkStatus.mockResolvedValue({
      wallet_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      chain_id: 8453,
      linked_at: '2026-02-13T00:00:00Z'
    });
    apiMocks.getStakeStatus.mockReset();
    apiMocks.getStakeStatus
      .mockResolvedValueOnce({
        staked_balance_wei: '1000000000000000000',
        unlock_time: '2020-01-01T00:00:00Z',
        lock_active: false
      })
      .mockResolvedValueOnce({
        staked_balance_wei: '0',
        unlock_time: '1970-01-01T00:00:00Z',
        lock_active: false
      });

    const user = userEvent.setup();
    renderAuthedContributorPage();
    const withdraw = await screen.findByRole('button', { name: 'Withdraw Stake' });
    await waitFor(() => expect((withdraw as HTMLButtonElement).disabled).toBe(false));
    await user.click(withdraw);

    await waitFor(() => {
      expect(wagmiMocks.writeContractAsync).toHaveBeenCalledWith({
        address: '0x1111111111111111111111111111111111111111',
        abi: expect.any(Array),
        functionName: 'withdraw'
      });
      expect(wagmiMocks.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xwithdraw-hash' });
      expect(screen.getByText('No active stake')).toBeTruthy();
    });
  });
});
