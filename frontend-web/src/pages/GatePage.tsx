import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, usePublicClient, useSignMessage, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import {
  confirmWalletLink,
  getConfirmTypedData,
  getGate,
  getStakeStatus,
  getStakingConfig,
  getWalletLinkStatus,
  githubSignIn,
  requestWalletLinkChallenge,
  submitGateConfirmation
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { gateBlockingMessage } from '../lib/gate';
import { normalizeConfirmTypedData } from '../lib/eip712';
import { assertTypedDataUsesStakingContract, stakingContractAddress } from '../lib/staking';
import { useAppState } from '../state';
import { SUPPORTED_CHAIN_ID } from '../lib/wagmi';
import type { GateResponse, StakeStatusResponse, StakingConfigResponse, WalletLinkStatusResponse } from '../types';
import { GateLoadingView, GateView, InvalidGateView } from './gate/GateView';
import { createGateViewModel, parseWeiToBigInt } from './gate/gate-view-model';

export const GATE_POLL_INTERVAL_MS = 5_000;

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

function clearLinkedWalletCache(githubLogin: string): void {
  try {
    const raw = localStorage.getItem(LINK_CACHE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, WalletLinkStatusResponse>;
    delete parsed[githubLogin];
    localStorage.setItem(LINK_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage failures.
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
  const latestGateStatus = useRef<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [stakeStatus, setStakeStatus] = useState<StakeStatusResponse | null>(null);
  const [walletLinkStatus, setWalletLinkStatus] = useState<WalletLinkStatusResponse | null>(null);
  const [ethUsdSpot, setEthUsdSpot] = useState<number | null>(null);

  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: SUPPORTED_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [stakingConfig, setStakingConfig] = useState<StakingConfigResponse | null>(null);

  useEffect(() => {
    if (!gateToken) {
      return;
    }

    let mounted = true;
    let hasLoadedGate = false;
    let pollTimer: number | undefined;
    latestGateStatus.current = null;
    setGate(null);
    setGateError(null);

    const refreshGate = async (): Promise<void> => {
      try {
        const result = await getGate(gateToken);
        if (!mounted) {
          return;
        }
        if (
          latestGateStatus.current !== null
          && latestGateStatus.current !== 'PENDING'
          && result.status === 'PENDING'
        ) {
          return;
        }
        hasLoadedGate = true;
        latestGateStatus.current = result.status;
        setGate(result);
        setGateError(null);
      } catch (error) {
        if (!mounted) {
          return;
        }
        if (!hasLoadedGate) {
          const message = toUserMessage(error);
          setGateError(message);
          pushNotice('error', message);
        }
      }

      if (mounted && latestGateStatus.current === 'PENDING') {
        pollTimer = window.setTimeout(() => {
          if (latestGateStatus.current === 'PENDING') {
            void refreshGate();
          }
        }, GATE_POLL_INTERVAL_MS);
      }
    };

    void refreshGate();

    return () => {
      mounted = false;
      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
      }
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
            setWalletLinkStatus(null);
            clearLinkedWalletCache(githubLogin);
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
  const connectedWalletAddress = account.address?.toLowerCase() ?? null;
  const linkedWalletAddressLower = linkedWalletAddress?.toLowerCase() ?? null;
  const isConnectedWalletLinked = Boolean(
    connectedWalletAddress
    && linkedWalletAddressLower
    && connectedWalletAddress === linkedWalletAddressLower
  );
  const stakeWalletAddress = (linkedWalletAddress ?? account.address)?.toLowerCase() ?? null;

  const readStakeStatusFromChain = async (walletAddress: `0x${string}`): Promise<StakeStatusResponse | null> => {
    const config = await resolveStakingConfig();
    if (!publicClient || !config) {
      return null;
    }
    const contractAddress = stakingContractAddress(config);
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
  }, [stakeWalletAddress, pushNotice, publicClient]);

  useEffect(() => {
    if (!gate) {
      return;
    }

    const interval = window.setInterval(() => {
      setNowMs(Date.now());
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
    return gateBlockingMessage(gate, state.me, nowMs);
  }, [gate, state.me, nowMs]);

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

  const resolveStakingConfig = async (): Promise<StakingConfigResponse> => {
    if (stakingConfig) {
      return stakingConfig;
    }

    const discovered = await getStakingConfig();
    stakingContractAddress(discovered);
    setStakingConfig(discovered);
    return discovered;
  };

  const resolveStakeContractForGate = async (deadlineAt: string): Promise<`0x${string}` | null> => {
    const config = await runBusy('stake-contract-resolve', resolveStakingConfig);
    if (!config) {
      pushNotice('error', 'Staking contract address is unavailable.');
      return null;
    }
    if (new Date(deadlineAt).getTime() <= Date.now()) {
      pushNotice('error', 'This challenge expired before the transaction could be submitted.');
      return null;
    }
    return stakingContractAddress(config);
  };

  const waitForStakeReceipt = async (hash: `0x${string}`): Promise<boolean> => {
    if (!publicClient) {
      return true;
    }
    const receipt = await runBusy('stake-receipt', async () => {
      pushNotice('info', 'Waiting for stake transaction confirmation...');
      const confirmedReceipt = await publicClient.waitForTransactionReceipt({ hash });
      if (confirmedReceipt.status !== 'success') {
        throw new Error('The stake transaction reverted.');
      }
      return confirmedReceipt;
    });
    return Boolean(receipt);
  };

  const refreshStakeAfterTransaction = async (requiredWei: bigint | null): Promise<void> => {
    if (!stakeWalletAddress) {
      return;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const latest = await getStakeStatus(stakeWalletAddress).catch(() => null);
      if (latest) {
        setStakeStatus(latest);
        if (stakeRequirementMet(latest, requiredWei)) {
          return;
        }
      }
      await sleep(1000);
    }
  };

  const handleStake = async (): Promise<void> => {
    if (!gate) {
      return;
    }
    const initialError = stakeRequestError(gate, account.address);
    if (initialError) {
      pushNotice('error', initialError);
      return;
    }
    if (!(await ensureBaseChain())) {
      return;
    }
    const address = account.address!;
    if (linkedWalletAddress && address.toLowerCase() !== linkedWalletAddress.toLowerCase()) {
      pushNotice('error', 'Connect the linked wallet before staking.');
      return;
    }

    const contractAddress = await resolveStakeContractForGate(gate.deadline_at);
    if (!contractAddress) {
      return;
    }

    const requiredWei = parseWeiToBigInt(gate.threshold_wei_snapshot);
    const currentWei = parseWeiToBigInt(stakeStatus?.staked_balance_wei ?? '0') ?? 0n;
    const value = additionalStakeValue(requiredWei, currentWei);

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
    if (!(await waitForStakeReceipt(hash))) {
      return;
    }
    await refreshStakeAfterTransaction(requiredWei);
  };

  const handleConfirm = async (): Promise<void> => {
    if (!gateToken) {
      return;
    }
    if (!(await ensureBaseChain())) {
      return;
    }

    const confirmed = await runBusy('gate-confirm', async () => {
      const [typed, config] = await Promise.all([
        getConfirmTypedData(gateToken),
        resolveStakingConfig()
      ]);
      assertTypedDataUsesStakingContract(typed, config);
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
    latestGateStatus.current = refreshed.status;
    setGate(refreshed);
  };

  const handleGitHubSignIn = (): void => {
    void runBusy('github-sign-in', () => githubSignIn(window.location.href));
  };

  if (!gateToken) {
    return <InvalidGateView />;
  }

  if (!gate) {
    return <GateLoadingView error={gateError} />;
  }

  const viewModel = createGateViewModel({
    gate,
    me: state.me,
    accountAddress: account.address,
    linkedWalletAddress,
    isConnectedWalletLinked,
    stakeStatus,
    nowMs,
    ethUsdSpot,
    blockingMessage,
    isBusy
  });

  return (
    <GateView
      gate={gate}
      model={viewModel}
      onGitHubSignIn={handleGitHubSignIn}
      onLinkWallet={handleLinkWallet}
      onStake={handleStake}
      onConfirm={handleConfirm}
    />
  );
}

function stakeRequestError(gate: GateResponse, address: string | undefined): string | null {
  if (gate.status !== 'PENDING' || new Date(gate.deadline_at).getTime() <= Date.now()) {
    return 'This challenge has expired.';
  }
  if (!address) {
    return 'Connect a wallet first.';
  }
  return null;
}

function additionalStakeValue(requiredWei: bigint | null, currentWei: bigint): bigint {
  if (requiredWei === null || currentWei >= requiredWei) {
    return 0n;
  }
  return requiredWei - currentWei;
}

function stakeRequirementMet(status: StakeStatusResponse, requiredWei: bigint | null): boolean {
  const nextStaked = parseWeiToBigInt(status.staked_balance_wei);
  return requiredWei !== null
    && nextStaked !== null
    && nextStaked >= requiredWei
    && status.lock_active;
}
