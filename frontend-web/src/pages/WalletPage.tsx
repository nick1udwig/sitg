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

  return (
    <section className="card">
      <h2>Wallet Link Management</h2>
      <p className="meta">One active wallet per GitHub account and one active GitHub account per wallet.</p>
      {!state.me ? (
        <button onClick={() => githubSignIn(window.location.href)} aria-label="Sign in with GitHub">
          Sign in with GitHub
        </button>
      ) : null}
      <dl className="kv">
        <dt>GitHub account</dt>
        <dd>{state.me ? `@${state.me.github_login}` : 'Not signed in'}</dd>
        <dt>Connected wallet</dt>
        <dd>{account.address ?? 'Not connected'}</dd>
        <dt>Linked wallet (backend)</dt>
        <dd>{walletLinkStatus?.wallet_address ?? 'Not linked or endpoint unavailable'}</dd>
        <dt>Chain</dt>
        <dd>{account.chainId ?? 'Unknown'}</dd>
      </dl>
      <div className="row-wrap">
        <button disabled={!state.me || !account.address || isBusy('wallet-link')} onClick={handleLink}>
          {isBusy('wallet-link') ? 'Linking...' : 'Link Connected Wallet'}
        </button>
        <button className="warn" disabled={!state.me || isBusy('wallet-unlink')} onClick={handleUnlink}>
          {isBusy('wallet-unlink') ? 'Unlinking...' : 'Unlink Wallet'}
        </button>
      </div>
    </section>
  );
}
