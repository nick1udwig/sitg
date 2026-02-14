import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useSignMessage, useSignTypedData, useSwitchChain } from 'wagmi';
import {
  confirmWalletLink,
  getConfirmTypedData,
  getGate,
  getStakeStatus,
  githubSignIn,
  requestWalletLinkChallenge,
  submitGateConfirmation
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { gateBlockingMessage, parseCountdown } from '../lib/gate';
import { normalizeConfirmTypedData } from '../lib/eip712';
import { useAppState } from '../state';
import { SUPPORTED_CHAIN_ID } from '../lib/wagmi';
import type { GateResponse, StakeStatusResponse } from '../types';

const STATUS_STYLES: Record<string, { dot: string; badge: string }> = {
  PENDING: { dot: 'amber', badge: 'warn' },
  VERIFIED: { dot: 'green', badge: 'ok' },
  TIMED_OUT_CLOSED: { dot: 'red', badge: 'err' }
};

function countdownMinutes(countdown: string): number {
  const parts = countdown.split(':');
  return parseInt(parts[0], 10);
}

export function GatePage() {
  const { gateToken } = useParams<{ gateToken: string }>();
  const { state, runBusy, isBusy, pushNotice } = useAppState();
  const [gate, setGate] = useState<GateResponse | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState('00:00');
  const [stakeStatus, setStakeStatus] = useState<StakeStatusResponse | null>(null);

  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();

  const stakeUrl = import.meta.env.VITE_STAKE_URL as string | undefined;

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
    if (!account.address) {
      setStakeStatus(null);
      return;
    }

    let mounted = true;
    void getStakeStatus(account.address)
      .then((status) => {
        if (mounted) {
          setStakeStatus(status);
        }
      })
      .catch((error) => {
        if (mounted) {
          pushNotice('error', toUserMessage(error));
        }
      });

    return () => {
      mounted = false;
    };
  }, [account.address, pushNotice]);

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
      const signature = await signMessageAsync({ message: challenge.message });
      return confirmWalletLink({ nonce: challenge.nonce, wallet_address: address, signature });
    });

    if (!result) {
      pushNotice('error', 'Wallet linking failed.');
      return;
    }

    pushNotice('success', `Wallet linked: ${result.wallet_address}`);
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

  return (
    <section className="grid two">
      <article className="card">
        <p className="meta" style={{ marginBottom: 4 }}>{gate.github_repo_full_name} &rsaquo; PR #{gate.github_pr_number}</p>
        <h2>PR Stake Gate</h2>
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

        <div className="step-list">
          <div className="step">
            <span className={`step-indicator${hasGitHub ? ' done' : ''}`}>{hasGitHub ? '\u2713' : '1'}</span>
            <span className={`step-label${hasGitHub ? ' done' : ''}`}>Sign in with GitHub</span>
            {!hasGitHub && (
              <button
                style={{ marginLeft: 'auto', padding: '4px 10px' }}
                disabled={isBusy('github-sign-in')}
                onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
              >
                {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in'}
              </button>
            )}
          </div>
          <div className="step">
            <span className={`step-indicator${hasWallet ? ' done' : ''}`}>{hasWallet ? '\u2713' : '2'}</span>
            <span className={`step-label${hasWallet ? ' done' : ''}`}>Connect wallet</span>
          </div>
          <div className="step">
            <span className="step-indicator">3</span>
            <span className="step-label">Link wallet to GitHub</span>
            <button
              className="ghost"
              style={{ marginLeft: 'auto', padding: '4px 10px' }}
              disabled={Boolean(blockingMessage) || !hasWallet || isBusy('wallet-link') || isBusy('switch-chain')}
              onClick={handleLinkWallet}
            >
              {isBusy('wallet-link') ? 'Linking...' : 'Link'}
            </button>
          </div>
          <div className="step">
            <span className="step-indicator">4</span>
            <span className="step-label">Sign PR confirmation</span>
            <button
              style={{ marginLeft: 'auto', padding: '4px 10px' }}
              disabled={Boolean(blockingMessage) || !hasWallet || isBusy('gate-confirm') || isBusy('switch-chain')}
              onClick={handleConfirm}
            >
              {isBusy('gate-confirm') ? 'Confirming...' : 'Sign'}
            </button>
          </div>
        </div>

        {stakeUrl ? (
          <div style={{ marginTop: 8 }}>
            <a className="button-like" href={stakeUrl} target="_blank" rel="noreferrer">
              Fund + Stake
            </a>
          </div>
        ) : null}
      </article>
    </section>
  );
}
