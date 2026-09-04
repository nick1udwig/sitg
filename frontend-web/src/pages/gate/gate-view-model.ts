import { gateReadyMessage, parseCountdown } from '../../lib/gate';
import type { GateResponse, MeResponse, StakeStatusResponse } from '../../types';
import type { GateViewModel } from './GateView';

const STATUS_STYLES: Record<string, { dot: string; badge: string }> = {
  PENDING: { dot: 'amber', badge: 'warn' },
  VERIFIED: { dot: 'green', badge: 'ok' },
  EXEMPT: { dot: 'green', badge: 'ok' },
  TIMED_OUT_CLOSED: { dot: 'red', badge: 'err' },
  CANCELED: { dot: 'red', badge: 'err' }
};

interface GateViewModelInput {
  gate: GateResponse;
  me: MeResponse | null;
  accountAddress?: string;
  linkedWalletAddress: string | null;
  isConnectedWalletLinked: boolean;
  stakeStatus: StakeStatusResponse | null;
  nowMs: number;
  ethUsdSpot: number | null;
  blockingMessage: string | null;
  isBusy: (key: string) => boolean;
}

interface StakePresentation {
  stakeSummary: string;
  hasSufficientBalance: boolean;
  hasSufficientStake: boolean;
  stakeLockActive: boolean;
}

interface ActionPresentation {
  linkButtonDisabled: boolean;
  linkButtonLabel: string;
  stakeButtonDisabled: boolean;
  stakeButtonLabel: string;
  confirmButtonDisabled: boolean;
  confirmButtonLabel: string;
  githubSignInDisabled: boolean;
  githubSignInLabel: string;
}

export function parseWeiToBigInt(value: string): bigint | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function createGateViewModel(input: GateViewModelInput): GateViewModel {
  const timing = createTimingPresentation(input.gate, input.nowMs);
  const stake = createStakePresentation(input);
  const actions = createActionPresentation(input, timing.isExpired, stake);
  const thresholdEth = weiToEth(input.gate.threshold_wei_snapshot);
  const thresholdUsdEstimate = formatThresholdUsd(thresholdEth, input.ethUsdSpot);

  return {
    statusDot: timing.statusDot,
    statusBadge: timing.statusBadge,
    countdown: timing.countdown,
    countdownClass: timing.countdownClass,
    thresholdUsdEstimate,
    stakeSummary: stake.stakeSummary,
    blockingMessage: input.blockingMessage,
    readyMessage: gateReadyMessage(input.gate),
    hasGitHub: Boolean(input.me),
    hasWallet: Boolean(input.accountAddress),
    isConnectedWalletLinked: input.isConnectedWalletLinked,
    hasSufficientStake: stake.hasSufficientStake,
    ...actions
  };
}

function createTimingPresentation(gate: GateResponse, nowMs: number) {
  const statusStyle = STATUS_STYLES[gate.status] ?? { dot: 'gray', badge: '' };
  const countdown = parseCountdown(gate.deadline_at, nowMs);
  const minutes = countdownMinutes(countdown);
  const isExpired = countdown === '00:00';
  const isWarning = !isExpired && minutes < 5;
  let countdownClass = 'countdown';
  if (isExpired) {
    countdownClass += ' expired';
  } else if (isWarning) {
    countdownClass += ' warning pulse';
  }
  return {
    statusDot: statusStyle.dot,
    statusBadge: statusStyle.badge,
    countdown,
    countdownClass,
    isExpired
  };
}

function createStakePresentation(input: GateViewModelInput): StakePresentation {
  const thresholdWei = parseWeiToBigInt(input.gate.threshold_wei_snapshot);
  const stakedWei = parseWeiToBigInt(input.stakeStatus?.staked_balance_wei ?? '');
  const stakeLockActive = Boolean(
    input.stakeStatus?.lock_active
    && new Date(input.stakeStatus.unlock_time).getTime() > input.nowMs
  );
  const hasSufficientBalance = Boolean(
    thresholdWei !== null
    && stakedWei !== null
    && stakedWei >= thresholdWei
  );
  const hasSufficientStake = input.isConnectedWalletLinked && hasSufficientBalance && stakeLockActive;
  return {
    stakeSummary: createStakeSummary(input.stakeStatus, input.accountAddress, stakeLockActive),
    hasSufficientBalance,
    hasSufficientStake,
    stakeLockActive
  };
}

function createStakeSummary(
  stakeStatus: StakeStatusResponse | null,
  accountAddress: string | undefined,
  stakeLockActive: boolean
): string {
  if (stakeStatus) {
    return `${stakeStatus.staked_balance_wei} wei \u00b7 lock ${stakeLockActive ? 'active' : 'inactive'}`;
  }
  if (accountAddress) {
    return 'Unavailable';
  }
  return 'Connect wallet';
}

function createActionPresentation(
  input: GateViewModelInput,
  isExpired: boolean,
  stake: StakePresentation
): ActionPresentation {
  const actionsBlocked = Boolean(input.blockingMessage) || input.gate.status !== 'PENDING' || isExpired;
  const hasWallet = Boolean(input.accountAddress);
  const hasLinkedWallet = Boolean(input.linkedWalletAddress);
  const canLinkWallet = hasWallet && (!hasLinkedWallet || !input.isConnectedWalletLinked);

  return {
    ...createLinkAction(input, actionsBlocked, canLinkWallet, hasLinkedWallet),
    ...createStakeAction(input, actionsBlocked, hasWallet, stake),
    ...createConfirmAction(input, actionsBlocked, hasWallet, stake.hasSufficientStake),
    ...createGitHubAction(input, actionsBlocked)
  };
}

function createLinkAction(
  input: GateViewModelInput,
  actionsBlocked: boolean,
  canLinkWallet: boolean,
  hasLinkedWallet: boolean
) {
  const busy = input.isBusy('wallet-link');
  let label = 'Link';
  if (input.isConnectedWalletLinked) {
    label = 'Linked';
  } else if (busy) {
    label = 'Linking...';
  } else if (hasLinkedWallet) {
    label = 'Relink';
  }
  return {
    linkButtonDisabled: actionsBlocked || !canLinkWallet || busy || input.isBusy('switch-chain'),
    linkButtonLabel: label
  };
}

function createStakeAction(
  input: GateViewModelInput,
  actionsBlocked: boolean,
  hasWallet: boolean,
  stake: StakePresentation
) {
  const transactionBusy = input.isBusy('stake-tx');
  const receiptBusy = input.isBusy('stake-receipt');
  let label = 'Stake';
  if (stake.hasSufficientStake) {
    label = 'Staked';
  } else if (receiptBusy) {
    label = 'Confirming...';
  } else if (transactionBusy) {
    label = 'Submitting...';
  } else if (stake.hasSufficientBalance && !stake.stakeLockActive) {
    label = 'Renew lock';
  }
  return {
    stakeButtonDisabled: actionsBlocked
      || !hasWallet
      || !input.isConnectedWalletLinked
      || stake.hasSufficientStake
      || transactionBusy
      || receiptBusy
      || input.isBusy('stake-contract-resolve')
      || input.isBusy('switch-chain'),
    stakeButtonLabel: label
  };
}

function createConfirmAction(
  input: GateViewModelInput,
  actionsBlocked: boolean,
  hasWallet: boolean,
  hasSufficientStake: boolean
) {
  const busy = input.isBusy('gate-confirm');
  return {
    confirmButtonDisabled: actionsBlocked
      || !hasWallet
      || !hasSufficientStake
      || busy
      || input.isBusy('switch-chain'),
    confirmButtonLabel: busy ? 'Confirming...' : 'Sign'
  };
}

function createGitHubAction(input: GateViewModelInput, actionsBlocked: boolean) {
  const busy = input.isBusy('github-sign-in');
  return {
    githubSignInDisabled: actionsBlocked || busy,
    githubSignInLabel: busy ? 'Redirecting...' : 'Sign in with GitHub'
  };
}

function countdownMinutes(countdown: string): number {
  return parseInt(countdown.split(':')[0], 10);
}

function weiToEth(wei: string): number | null {
  const numeric = Number(wei);
  return Number.isFinite(numeric) ? numeric / 1e18 : null;
}

function formatThresholdUsd(thresholdEth: number | null, ethUsdSpot: number | null): string | null {
  if (thresholdEth === null || ethUsdSpot === null) {
    return null;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(thresholdEth * ethUsdSpot);
}
