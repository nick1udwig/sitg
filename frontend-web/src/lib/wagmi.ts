import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  // RainbowKit requires a WalletConnect Cloud project id.
  console.warn('Missing VITE_WALLETCONNECT_PROJECT_ID; WalletConnect will not work until configured.');
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Stake-to-Contribute',
  projectId: projectId ?? 'missing-project-id',
  chains: [base],
  ssr: false
});

export const SUPPORTED_CHAIN_ID = base.id;
