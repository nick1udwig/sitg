import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, usePublicClient, useSignMessage, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import {
  confirmWalletLink,
  getConfirmTypedData,
  getGate,
  getStakeStatus,
  getWalletLinkStatus,
  githubSignIn,
  requestWalletLinkChallenge,
  submitGateConfirmation
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { gateBlockingMessage, parseCountdown } from '../lib/gate';
import { normalizeConfirmTypedData } from '../lib/eip712';
import { useAppState } from '../state';
import { SUPPORTED_CHAIN_ID } from '../lib/wagmi';
import type { GateResponse, StakeStatusResponse, WalletLinkStatusResponse } from '../types';

const STATUS_STYLES: Record<string, { dot: string; badge: string }> = {
  PENDING: { dot: 'amber', badge: 'warn' },
  VERIFIED: { dot: 'green', badge: 'ok' },
  TIMED_OUT_CLOSED: { dot: 'red', badge: 'err' }
};

function countdownMinutes(countdown: string): number {
  const parts = countdown.split(':');
  return parseInt(parts[0], 10);
}

function weiToEth(wei: string): number | null {
  const numeric = Number(wei);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric / 1e18;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

const LINK_CACHE_KEY = 'sitg.gateLinkedWalletByUser';
const STAKING_ABI = [
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'payable',
    inputs: [],
    outputs: []
  }
] as const;

function readLinkedWalletCache(githubLogin: string): WalletLinkStatusResponse | null {
  try {
    const raw = localStorage.getItem(LINK_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, WalletLinkStatusResponse>;
    return parsed[githubLogin] ?? null;
  } catch {
    return null;
  }
}

function writeLinkedWalletCache(githubLogin: string, payload: WalletLinkStatusResponse): void {
  try {
    const raw = localStorage.getItem(LINK_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, WalletLinkStatusResponse>) : {};
    parsed[githubLogin] = payload;
    localStorage.setItem(LINK_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage failures.
  }
}

function parseWeiToBigInt(value: string): bigint | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function GatePage() {
  const { gateToken } = useParams<{ gateToken: string }>();
  const { state, runBusy, isBusy, pushNotice } = useAppState();
  const [gate, setGate] = useState<GateResponse | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState('00:00');
  const [stakeStatus, setStakeStatus] = useState<StakeStatusResponse | null>(null);
  const [walletLinkStatus, setWalletLinkStatus] = useState<WalletLinkStatusResponse | null>(null);
  const [ethUsdSpot, setEthUsdSpot] = useState<number | null>(null);

  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: SUPPORTED_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [stakingContractAddress, setStakingContractAddress] = useState<`0x${string}` | null>(
    ((import.meta.env.VITE_STAKING_CONTRACT_ADDRESS as string | undefined)?.trim() as `0x${string}` | undefined) ?? null
  );

  useEffect(() => {
    if (!gateToken) {
      return;
    }

    let mounted = true;
    void getGate(gateToken)
      .then((result) => {
        if (!mounted) {
          return;
        }
        setGate(result);
        setCountdown(parseCountdown(result.deadline_at));
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        setGateError(toUserMessage(error));
        pushNotice('error', toUserMessage(error));
      });

    return () => {
      mounted = false;
    };
  }, [gateToken, pushNotice]);

  useEffect(() => {
    if (!state.me) {
      setWalletLinkStatus(null);
      return;
    }

    const githubLogin = state.me.github_login;
    let mounted = true;
    void getWalletLinkStatus()
      .then((status) => {
        if (mounted) {
          if (status) {
            setWalletLinkStatus(status);
            writeLinkedWalletCache(githubLogin, status);
          } else {
            setWalletLinkStatus(readLinkedWalletCache(githubLogin));
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setWalletLinkStatus(readLinkedWalletCache(githubLogin));
        }
      });

    return () => {
      mounted = false;
    };
  }, [state.me]);

  const linkedWalletAddress = walletLinkStatus?.wallet_address ?? null;
  const stakeWalletAddress = linkedWalletAddress ?? account.address ?? null;

  const readStakeStatusFromChain = async (walletAddress: `0x${string}`): Promise<StakeStatusResponse | null> => {
    const contractAddress = await resolveStakingContractAddress();
    if (!publicClient || !contractAddress) {
      return null;
    }
    const [stakedBalanceWei, unlockTimeUnix] = await Promise.all([
      publicClient.readContract({
        address: contractAddress,
        abi: [
          {
            type: 'function',
            name: 'stakedBalance',
            stateMutability: 'view',
            inputs: [{ name: 'user', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }]
          }
        ] as const,
        functionName: 'stakedBalance',
        args: [walletAddress]
      }),
      publicClient.readContract({
        address: contractAddress,
        abi: [
          {
            type: 'function',
            name: 'unlockTime',
            stateMutability: 'view',
            inputs: [{ name: 'user', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }]
          }
        ] as const,
        functionName: 'unlockTime',
        args: [walletAddress]
      })
    ]);

    const unlockTimeMs = Number(unlockTimeUnix) * 1000;
    const lockActive = stakedBalanceWei > 0n && unlockTimeMs > Date.now();
    return {
      staked_balance_wei: stakedBalanceWei.toString(),
      unlock_time: new Date(unlockTimeMs).toISOString(),
      lock_active: lockActive
    };
  };

  useEffect(() => {
    if (!stakeWalletAddress) {
      setStakeStatus(null);
      return;
    }

    let mounted = true;
    void getStakeStatus(stakeWalletAddress)
      .then(async (status) => {
        if (mounted) {
          if (status) {
            setStakeStatus(status);
            return;
          }
          if (stakeWalletAddress.startsWith('0x')) {
            const chainStatus = await readStakeStatusFromChain(stakeWalletAddress as `0x${string}`).catch(() => null);
            if (mounted) {
              setStakeStatus(chainStatus);
            }
          } else {
            setStakeStatus(null);
          }
        }
      })
      .catch(async (error) => {
        if (mounted) {
          if (stakeWalletAddress.startsWith('0x')) {
            const chainStatus = await readStakeStatusFromChain(stakeWalletAddress as `0x${string}`).catch(() => null);
            if (mounted) {
              setStakeStatus(chainStatus);
              if (!chainStatus) {
                pushNotice('error', toUserMessage(error));
              }
            }
          } else {
            pushNotice('error', toUserMessage(error));
          }
        }
      });

    return () => {
      mounted = false;
    };
  }, [stakeWalletAddress, pushNotice, publicClient, stakingContractAddress]);

  useEffect(() => {
    if (!gate) {
      return;
    }

    setCountdown(parseCountdown(gate.deadline_at));
    const interval = window.setInterval(() => {
      setCountdown(parseCountdown(gate.deadline_at));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [gate]);

  useEffect(() => {
    let mounted = true;
    void fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
      .then(async (response) => {
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { ethereum?: { usd?: number } };
        const usd = data?.ethereum?.usd;
        if (mounted && typeof usd === 'number' && Number.isFinite(usd)) {
          setEthUsdSpot(usd);
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, []);

  const blockingMessage = useMemo(() => {
    if (!gate) {
      return null;
    }
    return gateBlockingMessage(gate, state.me);
  }, [gate, state.me]);

  async function ensureBaseChain(): Promise<boolean> {
    if (!account.chainId || account.chainId === SUPPORTED_CHAIN_ID) {
      return true;
    }

    const switched = await runBusy('switch-chain', async () => {
      await switchChainAsync({ chainId: SUPPORTED_CHAIN_ID });
      return true;
    });

    if (!switched) {
      pushNotice('error', 'Switch to Base network before signing.');
      return false;
    }

    return true;
  }

  const handleLinkWallet = async (): Promise<void> => {
    const address = account.address;
    if (!address) {
      pushNotice('error', 'Connect a wallet first.');
      return;
    }

    if (!(await ensureBaseChain())) {
      return;
    }

    const result = await runBusy('wallet-link', async () => {
      const challenge = await requestWalletLinkChallenge();
      pushNotice('info', 'Check your wallet to sign the link request.');
      const signature = await signMessageAsync({ message: challenge.message });
      return confirmWalletLink({ nonce: challenge.nonce, wallet_address: address, signature });
    });

    if (!result) {
      pushNotice('error', 'Wallet linking failed.');
      return;
    }

    const refreshed = await getWalletLinkStatus().catch(() => null);
    const nextStatus =
      refreshed ?? {
        wallet_address: result.wallet_address,
        chain_id: account.chainId ?? SUPPORTED_CHAIN_ID,
        linked_at: new Date().toISOString()
      };
    setWalletLinkStatus(nextStatus);
    if (state.me) {
      writeLinkedWalletCache(state.me.github_login, nextStatus);
    }
    pushNotice('success', `Wallet linked: ${result.wallet_address}`);
  };

  const resolveStakingContractAddress = async (): Promise<`0x${string}` | null> => {
    if (stakingContractAddress) {
      return stakingContractAddress;
    }
    if (!gateToken) {
      return null;
    }

    const typed = await getConfirmTypedData(gateToken);
    const discovered = typed.domain.verifyingContract;
    setStakingContractAddress(discovered);
    return discovered;
  };

  const handleStake = async (): Promise<void> => {
    if (!gate) {
      return;
    }
    if (!account.address) {
      pushNotice('error', 'Connect a wallet first.');
      return;
    }
    if (!(await ensureBaseChain())) {
      return;
    }
    if (linkedWalletAddress && account.address.toLowerCase() !== linkedWalletAddress.toLowerCase()) {
      pushNotice('error', 'Connect the linked wallet before staking.');
      return;
    }

    const contractAddress = await runBusy('stake-contract-resolve', resolveStakingContractAddress);
    if (!contractAddress) {
      pushNotice('error', 'Staking contract address is unavailable.');
      return;
    }

    const requiredWei = parseWeiToBigInt(gate.threshold_wei_snapshot);
    const currentWei = parseWeiToBigInt(stakeStatus?.staked_balance_wei ?? '0') ?? 0n;
    const value = requiredWei && currentWei < requiredWei ? requiredWei - currentWei : 0n;

    const hash = await runBusy('stake-tx', async () => {
      pushNotice('info', 'Check your wallet to approve the stake transaction.');
      return writeContractAsync({
        address: contractAddress,
        abi: STAKING_ABI,
        functionName: 'stake',
        value
      });
    });

    if (!hash) {
      pushNotice('error', 'Stake transaction failed.');
      return;
    }

    pushNotice('success', `Stake transaction submitted: ${hash.slice(0, 10)}...`);
    if (publicClient) {
      await runBusy('stake-receipt', async () => {
        pushNotice('info', 'Waiting for stake transaction confirmation...');
        await publicClient.waitForTransactionReceipt({ hash });
        return true;
      });
    }

    if (stakeWalletAddress) {
      let latest: StakeStatusResponse | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        latest = await getStakeStatus(stakeWalletAddress).catch(() => null);
        if (latest) {
          setStakeStatus(latest);
          const nextStaked = parseWeiToBigInt(latest.staked_balance_wei);
          if (requiredWei !== null && nextStaked !== null && nextStaked >= requiredWei) {
            break;
          }
        }
        await sleep(1000);
      }
    }
  };

  const handleConfirm = async (): Promise<void> => {
    if (!gateToken) {
      return;
    }
    if (!(await ensureBaseChain())) {
      return;
    }

    const confirmed = await runBusy('gate-confirm', async () => {
      const typed = await getConfirmTypedData(gateToken);
      const normalized = normalizeConfirmTypedData(typed);

      pushNotice('info', 'Check your wallet to sign the PR confirmation.');
      const signature = await signTypedDataAsync({
        domain: normalized.domain,
        types: normalized.types,
        primaryType: normalized.primaryType,
        message: normalized.message
      });

      return submitGateConfirmation(gateToken, signature);
    });

    if (!confirmed) {
      pushNotice('error', 'PR confirmation failed.');
      return;
    }

    pushNotice('success', 'PR verified.');
    const refreshed = await getGate(gateToken);
    setGate(refreshed);
  };

  if (!gateToken) {
    return (
      <section className="card" style={{ maxWidth: 600, margin: '0 auto' }}>
        <h2>Contributor Gate</h2>
        <p className="error">Invalid gate URL.</p>
      </section>
    );
  }

  if (!gate) {
    return (
      <section className="grid two">
        {gateError ? (
          <article className="card" style={{ gridColumn: '1 / -1' }}>
            <h2>PR Stake Gate</h2>
            <div className="error-bar">{gateError}</div>
          </article>
        ) : (
          <>
            <article className="card"><p className="skeleton" /></article>
            <article className="card"><p className="skeleton" /></article>
          </>
        )}
      </section>
    );
  }

  const statusStyle = STATUS_STYLES[gate.status] ?? { dot: 'gray', badge: '' };
  const minutes = countdownMinutes(countdown);
  const isExpired = countdown === '00:00';
  const isWarning = !isExpired && minutes < 5;
  const countdownClass = `countdown${isExpired ? ' expired' : isWarning ? ' warning pulse' : ''}`;

  const hasGitHub = Boolean(state.me);
  const hasWallet = Boolean(account.address);
  const hasLinkedWallet = Boolean(linkedWalletAddress);
  const thresholdEth = weiToEth(gate.threshold_wei_snapshot);
  const thresholdUsdEstimate = thresholdEth !== null && ethUsdSpot !== null ? formatUsd(thresholdEth * ethUsdSpot) : null;
  const thresholdWei = parseWeiToBigInt(gate.threshold_wei_snapshot);
  const stakedWei = parseWeiToBigInt(stakeStatus?.staked_balance_wei ?? '');
  const hasSufficientStake = Boolean(
    hasLinkedWallet
    && thresholdWei !== null
    && stakedWei !== null
    && stakedWei >= thresholdWei
  );

  return (
    <section className="grid two">
      <article className="card">
        <p className="meta" style={{ marginBottom: 4 }}>{gate.github_repo_full_name} &rsaquo; PR #{gate.github_pr_number}</p>
        <h2>PR Stake Gate</h2>
        <div className="gate-explainer" style={{ marginBottom: 12 }}>
          <p className="gate-explainer-title">{gate.github_repo_full_name} has been getting too many contributions.</p>
          <p className="gate-explainer-copy">To ensure your commitment, we ask you to temporarily post a bond of {thresholdUsdEstimate ?? 'an amount shown below'}.</p>
          <p className="gate-explainer-copy">
            You can reclaim your bond after 30 days at
            {' '}
            <a href="https://sitg.io/contributor" target="_blank" rel="noreferrer">sitg.io/contributor</a>.
          </p>
        </div>
        <span className={`badge ${statusStyle.badge}`}>
          <span className={`status-dot ${statusStyle.dot}`} />
          {gate.status}
        </span>

        <div className={countdownClass} aria-live="polite" aria-label={`Time remaining ${countdown}`}>
          {countdown}
        </div>

        <dl className="kv">
          <dt>Author</dt>
          <dd>@{gate.github_pr_author_login}</dd>
          <dt>Head SHA</dt>
          <dd>{gate.head_sha.slice(0, 12)}</dd>
          <dt>Threshold (wei)</dt>
          <dd>{gate.threshold_wei_snapshot}</dd>
          <dt>Threshold (USD estimate)</dt>
          <dd>{thresholdUsdEstimate ?? 'Unavailable right now'}</dd>
          <dt>Stake</dt>
          <dd>
            {stakeStatus
              ? `${stakeStatus.staked_balance_wei} wei \u00b7 lock ${stakeStatus.lock_active ? 'active' : 'inactive'}`
              : account.address
                ? 'Unavailable'
                : 'Connect wallet'}
          </dd>
        </dl>
      </article>

      <article className="card">
        <h3>Verification</h3>

        {blockingMessage ? (
          <div className="error-bar">{blockingMessage}</div>
        ) : (
          <div className="success-bar">Ready for verification.</div>
        )}

        {!hasGitHub && (
          <div className="row-wrap" style={{ marginTop: 8 }}>
            <button
              disabled={isBusy('github-sign-in')}
              onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
            >
              {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in with GitHub'}
            </button>
          </div>
        )}

        <div className="step-list">
          <div className="step">
            <span className={`step-indicator${hasGitHub ? ' done' : ''}`}>{hasGitHub ? '\u2713' : '1'}</span>
            <span className={`step-label${hasGitHub ? ' done' : ''}`}>Sign in with GitHub</span>
          </div>
          <div className="step">
            <span className={`step-indicator${hasWallet ? ' done' : ''}`}>{hasWallet ? '\u2713' : '2'}</span>
            <span className={`step-label${hasWallet ? ' done' : ''}`}>Connect wallet</span>
          </div>
          <div className="step">
            <span className={`step-indicator${hasLinkedWallet ? ' done' : ''}`}>{hasLinkedWallet ? '\u2713' : '3'}</span>
            <span className={`step-label${hasLinkedWallet ? ' done' : ''}`}>Link wallet to GitHub</span>
            <button
              className="ghost"
              style={{ marginLeft: 'auto', padding: '4px 10px' }}
              disabled={Boolean(blockingMessage) || !hasWallet || hasLinkedWallet || isBusy('wallet-link') || isBusy('switch-chain')}
              onClick={handleLinkWallet}
            >
              {hasLinkedWallet ? 'Linked' : isBusy('wallet-link') ? 'Linking...' : 'Link'}
            </button>
          </div>
          <div className="step">
            <span className={`step-indicator${hasSufficientStake ? ' done' : ''}`}>{hasSufficientStake ? '\u2713' : '4'}</span>
            <span className={`step-label${hasSufficientStake ? ' done' : ''}`}>Stake</span>
            <button
              className="ghost"
              style={{ marginLeft: 'auto', padding: '4px 10px' }}
              disabled={
                Boolean(blockingMessage)
                || !hasWallet
                || !hasLinkedWallet
                || hasSufficientStake
                || isBusy('stake-tx')
                || isBusy('stake-receipt')
                || isBusy('stake-contract-resolve')
                || isBusy('switch-chain')
              }
              onClick={handleStake}
            >
              {hasSufficientStake ? 'Staked' : isBusy('stake-receipt') ? 'Confirming...' : isBusy('stake-tx') ? 'Submitting...' : 'Stake'}
            </button>
          </div>
          <div className="step">
            <span className="step-indicator">5</span>
            <span className="step-label">Sign PR confirmation</span>
            <button
              style={{ marginLeft: 'auto', padding: '4px 10px' }}
              disabled={Boolean(blockingMessage) || !hasWallet || !hasSufficientStake || isBusy('gate-confirm') || isBusy('switch-chain')}
              onClick={handleConfirm}
            >
              {isBusy('gate-confirm') ? 'Confirming...' : 'Sign'}
            </button>
          </div>
        </div>
      </article>
    </section>
  );
}
