import { useEffect, useState } from 'react';
import { useAccount, useSignMessage, useSwitchChain } from 'wagmi';
import {
  confirmWalletLink,
  getWalletLinkStatus,
  githubSignIn,
  requestWalletLinkChallenge,
  unlinkWallet
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { SUPPORTED_CHAIN_ID } from '../lib/wagmi';
import { useAppState } from '../state';
import type { WalletLinkStatusResponse } from '../types';

const CHAIN_NAMES: Record<number, string> = { 8453: 'Base', 84532: 'Base Sepolia' };

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletPage() {
  const { state, runBusy, isBusy, pushNotice } = useAppState();
  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const [walletLinkStatus, setWalletLinkStatus] = useState<WalletLinkStatusResponse | null>(null);

  useEffect(() => {
    if (!state.me) {
      setWalletLinkStatus(null);
      return;
    }

    let mounted = true;
    void getWalletLinkStatus()
      .then((status) => {
        if (mounted) {
          setWalletLinkStatus(status);
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
  }, [state.me, pushNotice]);

  const ensureBaseChain = async (): Promise<boolean> => {
    if (!account.chainId || account.chainId === SUPPORTED_CHAIN_ID) {
      return true;
    }

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
      pushNotice('error', 'Wallet link failed.');
      return;
    }

    pushNotice('success', `Wallet linked: ${result.wallet_address}`);
    const refreshed = await getWalletLinkStatus();
    setWalletLinkStatus(refreshed);
  };

  const handleUnlink = async (): Promise<void> => {
    const result = await runBusy('wallet-unlink', async () => {
      await unlinkWallet();
      return true;
    });

    if (!result) {
      pushNotice('error', 'Wallet unlink failed.');
      return;
    }

    pushNotice('success', 'Wallet unlinked.');
    setWalletLinkStatus(null);
  };

  const chainName = account.chainId ? (CHAIN_NAMES[account.chainId] ?? `Chain ${account.chainId}`) : 'Unknown';

  return (
    <section className="grid" style={{ maxWidth: 600, margin: '0 auto' }}>
      <article className="card">
        <h2>Wallet Link</h2>
        <p className="meta">One active wallet per GitHub account and one active GitHub account per wallet.</p>

        {!state.me ? (
          <button
            disabled={isBusy('github-sign-in')}
            onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
            aria-label="Sign in with GitHub"
          >
            {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in with GitHub'}
          </button>
        ) : null}

        <dl className="kv">
          <dt>GitHub</dt>
          <dd>
            {state.me ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="status-dot green" />
                @{state.me.github_login}
              </span>
            ) : (
              <span style={{ color: 'var(--ink-soft)' }}>Not signed in</span>
            )}
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
        </dl>

        <div className="row-wrap">
          <button disabled={!state.me || !account.address || isBusy('wallet-link')} onClick={handleLink}>
            {isBusy('wallet-link') ? 'Linking...' : 'Link Wallet'}
          </button>
          <button className="warn" disabled={!state.me || isBusy('wallet-unlink')} onClick={handleUnlink}>
            {isBusy('wallet-unlink') ? 'Unlinking...' : 'Unlink Wallet'}
          </button>
        </div>
      </article>
    </section>
  );
}
