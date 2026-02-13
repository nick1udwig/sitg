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

export function GatePage() {
  const { gateToken } = useParams<{ gateToken: string }>();
  const { state, runBusy, isBusy, pushNotice } = useAppState();
  const [gate, setGate] = useState<GateResponse | null>(null);
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
      <section className="card">
        <h2>Contributor Gate</h2>
        <p className="error">Invalid gate URL.</p>
      </section>
    );
  }

  if (!gate) {
    return (
      <section className="grid two">
        <article className="card"><p className="skeleton" /></article>
        <article className="card"><p className="skeleton" /></article>
      </section>
    );
  }

  return (
    <section className="grid two">
      <article className="card">
        <h2>PR Stake Gate <span className="badge">{gate.status}</span></h2>
        <p className="meta">{gate.github_repo_full_name} · PR #{gate.github_pr_number}</p>
        <p className="countdown" aria-live="polite" aria-label={`Time remaining ${countdown}`}>{countdown}</p>
        <dl className="kv">
          <dt>Challenge author</dt>
          <dd>@{gate.github_pr_author_login}</dd>
          <dt>Head SHA</dt>
          <dd>{gate.head_sha.slice(0, 12)}...</dd>
          <dt>Threshold snapshot (wei)</dt>
          <dd>{gate.threshold_wei_snapshot}</dd>
          <dt>Stake status</dt>
          <dd>
            {stakeStatus
              ? `${stakeStatus.staked_balance_wei} wei · lock ${stakeStatus.lock_active ? 'active' : 'inactive'}`
              : account.address
                ? 'Stake endpoint unavailable or not configured'
                : 'Connect wallet to check'}
          </dd>
        </dl>
      </article>

      <article className="card">
        <h3>Verification Actions</h3>
        {blockingMessage ? <p className="error">{blockingMessage}</p> : <p className="success">Ready for verification.</p>}
        <ul className="list">
          <li>Connect wallet (header).</li>
          <li>Link wallet to your GitHub account.</li>
          <li>Sign PR confirmation before deadline.</li>
        </ul>
        <div className="row-wrap">
          {!state.me ? (
            <button onClick={() => githubSignIn(window.location.href)} aria-label="Sign in with GitHub">
              Sign in with GitHub
            </button>
          ) : null}
          <button
            className="ghost"
            disabled={Boolean(blockingMessage) || !account.address || isBusy('wallet-link') || isBusy('switch-chain')}
            onClick={handleLinkWallet}
            aria-label="Link connected wallet"
          >
            {isBusy('wallet-link') ? 'Linking...' : 'Link Wallet'}
          </button>
          <button
            disabled={Boolean(blockingMessage) || !account.address || isBusy('gate-confirm') || isBusy('switch-chain')}
            onClick={handleConfirm}
            aria-label="Sign PR confirmation"
          >
            {isBusy('gate-confirm') ? 'Confirming...' : 'Sign PR Confirmation'}
          </button>
          {stakeUrl ? (
            <a className="button-like" href={stakeUrl} target="_blank" rel="noreferrer">
              Fund + Stake
            </a>
          ) : null}
        </div>
      </article>
    </section>
  );
}
