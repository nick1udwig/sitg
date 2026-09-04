import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppStateProvider } from '../state';

const pendingGate = {
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
};

const apiMocks = vi.hoisted(() => ({
  getGate: vi.fn(),
  getWalletLinkStatus: vi.fn(),
  getStakeStatus: vi.fn()
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: 8453 }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() })
}));

vi.mock('../lib/wagmi', () => ({
  SUPPORTED_CHAIN_ID: 8453
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<object>('../api');
  return {
    ...actual,
    ...apiMocks
  };
});

import { GATE_POLL_INTERVAL_MS, GatePage } from './GatePage';

function renderGate() {
  return render(
    <AppStateProvider>
      <MemoryRouter initialEntries={['/g/token']}>
        <Routes>
          <Route path="/g/:gateToken" element={<GatePage />} />
        </Routes>
      </MemoryRouter>
    </AppStateProvider>
  );
}

describe('GatePage flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getGate.mockResolvedValue(pendingGate);
    apiMocks.getWalletLinkStatus.mockResolvedValue(null);
    apiMocks.getStakeStatus.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders gate details and sign-in action', async () => {
    renderGate();

    expect(await screen.findByText(/PR Stake Gate/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy();
  });

  it('polls pending gates and stops after receiving a terminal status', async () => {
    vi.useFakeTimers();
    apiMocks.getGate
      .mockResolvedValueOnce(pendingGate)
      .mockResolvedValueOnce({ ...pendingGate, status: 'VERIFIED' });

    await act(async () => {
      renderGate();
    });
    expect(apiMocks.getGate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_POLL_INTERVAL_MS);
    });
    expect(apiMocks.getGate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('This pull request has been verified.')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_POLL_INTERVAL_MS * 2);
    });
    expect(apiMocks.getGate).toHaveBeenCalledTimes(2);
  });
});
