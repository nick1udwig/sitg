import { useEffect, useState } from 'react';
import { useAccount, usePublicClient, useSignMessage, useSwitchChain, useWriteContract } from 'wagmi';
import {
  confirmWalletLink,
  getStakeStatus,
  getStakingConfig,
  getWalletLinkStatus,
  githubSignIn,
  requestWalletLinkChallenge,
  unlinkWallet
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { stakingContractAddress } from '../lib/staking';
import { SUPPORTED_CHAIN_ID } from '../lib/wagmi';
import { useAppState } from '../state';
import type { StakeStatusResponse, StakingConfigResponse, WalletLinkStatusResponse } from '../types';

const CHAIN_NAMES: Record<number, string> = { 8453: 'Base', 84532: 'Base Sepolia' };
const STAKING_ABI = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  }
] as const;

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ContributorPage() {
  const { state, runBusy, isBusy, pushNotice } = useAppState();
  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: SUPPORTED_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [walletLinkStatus, setWalletLinkStatus] = useState<WalletLinkStatusResponse | null>(null);
  const [stakeStatus, setStakeStatus] = useState<StakeStatusResponse | null>(null);
  const [stakingConfig, setStakingConfig] = useState<StakingConfigResponse | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!state.me) {
      setWalletLinkStatus(null);
      return;
    }

    let mounted = true;
    void getWalletLinkStatus()
      .then((status) => {
        if (mounted) setWalletLinkStatus(status);
      })
      .catch((error) => {
        if (mounted) pushNotice('error', toUserMessage(error));
      });

    return () => { mounted = false; };
  }, [state.me, pushNotice]);

  useEffect(() => {
    if (!state.me) {
      setStakingConfig(null);
      return;
    }

    let mounted = true;
    void getStakingConfig()
      .then((config) => {
        stakingContractAddress(config);
        if (mounted) setStakingConfig(config);
      })
      .catch((error) => {
        if (mounted) pushNotice('error', toUserMessage(error));
      });

    return () => { mounted = false; };
  }, [state.me, pushNotice]);

  useEffect(() => {
    const walletAddress = walletLinkStatus?.wallet_address;
    if (!walletAddress) {
      setStakeStatus(null);
      return;
    }

    let mounted = true;
    void getStakeStatus(walletAddress)
      .then((status) => {
        if (mounted) setStakeStatus(status);
      })
      .catch((error) => {
        if (mounted) pushNotice('error', toUserMessage(error));
      });

    return () => { mounted = false; };
  }, [walletLinkStatus?.wallet_address, pushNotice]);

  useEffect(() => {
    if (!stakeStatus || stakeStatus.staked_balance_wei === '0') return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [stakeStatus]);

  const ensureBaseChain = async (): Promise<boolean> => {
    if (!account.chainId || account.chainId === SUPPORTED_CHAIN_ID) return true;

    const switched = await runBusy('switch-chain', async () => {
      await switchChainAsync({ chainId: SUPPORTED_CHAIN_ID });
      return true;
    });

    if (!switched) {
      pushNotice('error', 'Could not switch to Base network.');
      return false;
    }
    return true;
  };

  const handleLink = async (): Promise<void> => {
    const address = account.address;
    if (!address) { pushNotice('error', 'Connect a wallet first.'); return; }
    if (!(await ensureBaseChain())) return;

    const result = await runBusy('wallet-link', async () => {
      const challenge = await requestWalletLinkChallenge();
      const signature = await signMessageAsync({ message: challenge.message });
      return confirmWalletLink({ nonce: challenge.nonce, wallet_address: address, signature });
    });

    if (!result) { pushNotice('error', 'Wallet link failed.'); return; }
    pushNotice('success', `Wallet linked: ${result.wallet_address}`);
    const refreshed = await getWalletLinkStatus();
    setWalletLinkStatus(refreshed);
  };

  const handleUnlink = async (): Promise<void> => {
    const result = await runBusy('wallet-unlink', async () => {
      await unlinkWallet();
      return true;
    });

    if (!result) { pushNotice('error', 'Wallet unlink failed.'); return; }
    pushNotice('success', 'Wallet unlinked.');
    setWalletLinkStatus(null);
  };

  const handleWithdraw = async (): Promise<void> => {
    if (!account.address || !walletLinkStatus || !stakingConfig || !stakeStatus) {
      pushNotice('error', 'Connect the linked wallet before withdrawing.');
      return;
    }
    if (account.address.toLowerCase() !== walletLinkStatus.wallet_address.toLowerCase()) {
      pushNotice('error', 'Connect the linked wallet before withdrawing.');
      return;
    }
    let currentBalance: bigint;
    try {
      currentBalance = BigInt(stakeStatus.staked_balance_wei);
    } catch {
      pushNotice('error', 'The stake balance returned by the backend is invalid.');
      return;
    }
    if (currentBalance <= 0n) {
      pushNotice('error', 'There is no stake to withdraw.');
      return;
    }
    const unlockTime = new Date(stakeStatus.unlock_time).getTime();
    if (!Number.isFinite(unlockTime) || unlockTime > Date.now()) {
      pushNotice('error', 'The stake is still locked.');
      return;
    }
    if (!publicClient) {
      pushNotice('error', 'Base network is unavailable. Retry after reconnecting your wallet.');
      return;
    }
    if (!(await ensureBaseChain())) return;

    const contractAddress = stakingContractAddress(stakingConfig);
    const hash = await runBusy('stake-withdraw-tx', async () => {
      pushNotice('info', 'Check your wallet to approve the withdrawal.');
      return writeContractAsync({
        address: contractAddress,
        abi: STAKING_ABI,
        functionName: 'withdraw'
      });
    });
    if (!hash) return;

    const receipt = await runBusy('stake-withdraw-receipt', async () => {
      pushNotice('info', 'Waiting for withdrawal confirmation...');
      const confirmedReceipt = await publicClient.waitForTransactionReceipt({ hash });
      if (confirmedReceipt.status !== 'success') {
        throw new Error('The withdrawal transaction reverted.');
      }
      return confirmedReceipt;
    });
    if (!receipt) return;

    const refreshed = await getStakeStatus(walletLinkStatus.wallet_address).catch(() => null);
    setStakeStatus(refreshed ?? {
      staked_balance_wei: '0',
      unlock_time: new Date(0).toISOString(),
      lock_active: false
    });
    pushNotice('success', 'Stake withdrawn.');
  };

  if (!state.me) {
    return (
      <div className="auth-prompt">
        <div className="landing-brand">Skin In The Game</div>
        <p className="auth-prompt-desc">
          Link your wallet to your GitHub account. When a bot posts a gate link on your PR, click it to verify your stake.
        </p>
        <button
          disabled={isBusy('github-sign-in')}
          onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
          aria-label="Sign in with GitHub"
        >
          {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in with GitHub'}
        </button>
      </div>
    );
  }

  const chainName = account.chainId ? (CHAIN_NAMES[account.chainId] ?? `Chain ${account.chainId}`) : 'Unknown';
  const stakeBalance = (() => {
    try {
      return BigInt(stakeStatus?.staked_balance_wei ?? '0');
    } catch {
      return 0n;
    }
  })();
  const lockEndsAt = stakeStatus ? new Date(stakeStatus.unlock_time).getTime() : 0;
  const lockActive = stakeBalance > 0n && lockEndsAt > nowMs;
  const connectedWalletIsLinked = Boolean(
    account.address
    && walletLinkStatus?.wallet_address
    && account.address.toLowerCase() === walletLinkStatus.wallet_address.toLowerCase()
  );
  const canWithdraw = Boolean(
    stakingConfig
    && connectedWalletIsLinked
    && stakeBalance > 0n
    && !lockActive
  );

  return (
    <section className="grid" style={{ maxWidth: 600, margin: '0 auto' }}>
      <article className="card">
        <h2>Wallet Link</h2>
        <p className="meta">Link your wallet to your GitHub account. When a bot posts a gate link on your PR, click it to verify your stake.</p>

        <dl className="kv">
          <dt>GitHub</dt>
          <dd>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="status-dot green" />
              @{state.me.github_login}
            </span>
          </dd>
          <dt>Wallet</dt>
          <dd>{account.address ? truncateAddress(account.address) : <span style={{ color: 'var(--ink-soft)' }}>Not connected</span>}</dd>
          <dt>Linked wallet</dt>
          <dd>
            {walletLinkStatus?.wallet_address
              ? truncateAddress(walletLinkStatus.wallet_address)
              : <span style={{ color: 'var(--ink-soft)' }}>Not linked</span>}
          </dd>
          <dt>Chain</dt>
          <dd>{chainName}</dd>
          <dt>Staked balance</dt>
          <dd>{stakeStatus ? `${stakeStatus.staked_balance_wei} wei` : 'No linked-wallet stake found'}</dd>
          <dt>Stake lock</dt>
          <dd>
            {stakeBalance > 0n
              ? lockActive
                ? `Locked until ${new Date(stakeStatus!.unlock_time).toLocaleString()}`
                : 'Unlocked'
              : 'No active stake'}
          </dd>
        </dl>

        <div className="row-wrap">
          <button disabled={!state.me || !account.address || isBusy('wallet-link')} onClick={handleLink}>
            {isBusy('wallet-link') ? 'Linking...' : 'Link Wallet'}
          </button>
          <button className="warn" disabled={!state.me || stakeBalance > 0n || isBusy('wallet-unlink')} onClick={handleUnlink}>
            {isBusy('wallet-unlink') ? 'Unlinking...' : stakeBalance > 0n ? 'Withdraw Before Unlinking' : 'Unlink Wallet'}
          </button>
          <button
            disabled={!canWithdraw || isBusy('stake-withdraw-tx') || isBusy('stake-withdraw-receipt') || isBusy('switch-chain')}
            onClick={handleWithdraw}
          >
            {isBusy('stake-withdraw-receipt')
              ? 'Confirming...'
              : isBusy('stake-withdraw-tx')
                ? 'Submitting...'
                : 'Withdraw Stake'}
          </button>
        </div>
      </article>
    </section>
  );
}
