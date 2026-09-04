import '@rainbow-me/rainbowkit/styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';

import { wagmiConfig } from '../lib/wagmi';
import { ContributorLayout } from './ContributorLayout';

const queryClient = new QueryClient();

export function ContributorRouteLayout() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <ContributorLayout />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
