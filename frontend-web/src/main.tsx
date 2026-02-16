import '@rainbow-me/rainbowkit/styles.css';
import './styles.css';

import { StrictMode, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';

import { App } from './App';
import { getMe } from './api';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { useAppState, AppStateProvider } from './state';
import { wagmiConfig } from './lib/wagmi';
import { toUserMessage } from './lib/error-map';

const queryClient = new QueryClient();

function Bootstrapper({ children }: { children: ReactNode }) {
  const { setMe, pushNotice } = useAppState();
  const didInit = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    const reason = params.get('reason');
    if (auth === 'cancelled') {
      if (reason === 'access_denied') {
        pushNotice('info', 'GitHub sign-in was cancelled.');
      } else {
        pushNotice('error', 'GitHub sign-in failed. Please retry.');
      }
      params.delete('auth');
      params.delete('reason');
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }

    let mounted = true;

    void getMe()
      .then((me) => {
        if (!mounted) {
          return;
        }
        setMe(me);
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        pushNotice('error', toUserMessage(error));
      });

    const handleError = (event: ErrorEvent): void => {
      pushNotice('error', event.message || 'Unexpected runtime error.');
    };
    const handleRejection = (event: PromiseRejectionEvent): void => {
      pushNotice('error', toUserMessage(event.reason));
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    if (!didInit.current) {
      didInit.current = true;
      const path = window.location.pathname;
      const isContributorRoute = path.startsWith('/contributor') || path.startsWith('/g/');
      if (!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID && isContributorRoute) {
        pushNotice('info', 'Set VITE_WALLETCONNECT_PROJECT_ID to fully enable WalletConnect.');
      }
      const isOwnerRoute = path.startsWith('/owner');
      if (!import.meta.env.VITE_GITHUB_APP_INSTALL_URL && isOwnerRoute) {
        pushNotice('info', 'Set VITE_GITHUB_APP_INSTALL_URL for owner onboarding install CTA.');
      }
    }

    return () => {
      mounted = false;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [setMe, pushNotice]);

  return <>{children}</>;
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}

createRoot(root).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <AppStateProvider>
            <BrowserRouter>
              <Bootstrapper>
                <AppErrorBoundary>
                  <App />
                </AppErrorBoundary>
              </Bootstrapper>
            </BrowserRouter>
          </AppStateProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>
);
