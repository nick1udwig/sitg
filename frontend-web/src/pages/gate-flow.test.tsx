import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppStateProvider } from '../state';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: 8453 }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() })
}));

vi.mock('../lib/wagmi', () => ({
  SUPPORTED_CHAIN_ID: 8453
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<object>('../api');
  return {
    ...actual,
    getGate: vi.fn().mockResolvedValue({
      challenge_id: 'c',
      status: 'PENDING',
      github_repo_id: 1,
      github_repo_full_name: 'org/repo',
      github_pr_number: 42,
      github_pr_author_id: 2,
      github_pr_author_login: 'alice',
      head_sha: 'abc123abc123abc123abc123abc123abc123abcd',
      deadline_at: '2099-01-01T00:10:00Z',
      threshold_wei_snapshot: '1'
    }),
    getStakeStatus: vi.fn().mockResolvedValue(null)
  };
});

import { GatePage } from './GatePage';

describe('GatePage flow', () => {
  it('renders gate details and sign-in action', async () => {
    render(
      <AppStateProvider>
        <MemoryRouter initialEntries={['/g/token']}>
          <Routes>
            <Route path="/g/:gateToken" element={<GatePage />} />
          </Routes>
        </MemoryRouter>
      </AppStateProvider>
    );

    expect(await screen.findByText(/PR Stake Gate/)).toBeTruthy();
    expect(screen.getByText('Sign in with GitHub')).toBeTruthy();
  });
});
