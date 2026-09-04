import type { StakeStatusResponse, WalletLinkStatusResponse } from '../../types';

const CHAIN_NAMES: Record<number, string> = { 8453: 'Base', 84532: 'Base Sepolia' };

interface ContributorAuthPromptProps {
  busy: boolean;
  onSignIn: () => void;
}

interface ContributorViewProps {
  githubLogin: string;
  walletAddress?: string;
  chainId?: number;
  walletLinkStatus: WalletLinkStatusResponse | null;
  stakeStatus: StakeStatusResponse | null;
  stakingConfigured: boolean;
  nowMs: number;
  isBusy: (key: string) => boolean;
  onLink: () => void;
  onUnlink: () => void;
  onWithdraw: () => void;
}

interface ContributorViewModel {
  walletLabel: string | null;
  linkedWalletLabel: string | null;
  chainLabel: string;
  stakeBalanceLabel: string;
  stakeLockLabel: string;
  linkDisabled: boolean;
  linkLabel: string;
  unlinkDisabled: boolean;
  unlinkLabel: string;
  withdrawDisabled: boolean;
  withdrawLabel: string;
}

export function ContributorAuthPrompt({ busy, onSignIn }: ContributorAuthPromptProps) {
  return (
    <div className="auth-prompt">
      <div className="landing-brand">Skin In The Game</div>
      <p className="auth-prompt-desc">
        Link your wallet to your GitHub account. When a bot posts a gate link on your PR, click it to verify your stake.
      </p>
      <button disabled={busy} onClick={onSignIn} aria-label="Sign in with GitHub">
        {busy ? 'Redirecting...' : 'Sign in with GitHub'}
      </button>
    </div>
  );
}

export function ContributorView(props: ContributorViewProps) {
  const view = createContributorViewModel(props);

  return (
    <section className="grid" style={{ maxWidth: 600, margin: '0 auto' }}>
      <article className="card">
        <h2>Wallet Link</h2>
        <p className="meta">Link your wallet to your GitHub account. When a bot posts a gate link on your PR, click it to verify your stake.</p>

        <WalletDetails githubLogin={props.githubLogin} view={view} />
        <WalletActions view={view} onLink={props.onLink} onUnlink={props.onUnlink} onWithdraw={props.onWithdraw} />
      </article>
    </section>
  );
}

function WalletDetails({ githubLogin, view }: { githubLogin: string; view: ContributorViewModel }) {
  return (
    <dl className="kv">
      <dt>GitHub</dt>
      <dd>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="status-dot green" />
          @{githubLogin}
        </span>
      </dd>
      <dt>Wallet</dt>
      <dd>{view.walletLabel ?? <MissingValue>Not connected</MissingValue>}</dd>
      <dt>Linked wallet</dt>
      <dd>{view.linkedWalletLabel ?? <MissingValue>Not linked</MissingValue>}</dd>
      <dt>Chain</dt>
      <dd>{view.chainLabel}</dd>
      <dt>Staked balance</dt>
      <dd>{view.stakeBalanceLabel}</dd>
      <dt>Stake lock</dt>
      <dd>{view.stakeLockLabel}</dd>
    </dl>
  );
}

function MissingValue({ children }: { children: string }) {
  return <span style={{ color: 'var(--ink-soft)' }}>{children}</span>;
}

function WalletActions({
  view,
  onLink,
  onUnlink,
  onWithdraw
}: {
  view: ContributorViewModel;
  onLink: () => void;
  onUnlink: () => void;
  onWithdraw: () => void;
}) {
  return (
    <div className="row-wrap">
      <button disabled={view.linkDisabled} onClick={onLink}>{view.linkLabel}</button>
      <button className="warn" disabled={view.unlinkDisabled} onClick={onUnlink}>{view.unlinkLabel}</button>
      <button disabled={view.withdrawDisabled} onClick={onWithdraw}>{view.withdrawLabel}</button>
    </div>
  );
}

function createContributorViewModel(props: ContributorViewProps): ContributorViewModel {
  const stakeBalance = parseStakeBalance(props.stakeStatus);
  const lockActive = stakeLockIsActive(props.stakeStatus, stakeBalance, props.nowMs);
  const connectedWalletIsLinked = walletsMatch(props.walletAddress, props.walletLinkStatus?.wallet_address);
  const canWithdraw = props.stakingConfigured && connectedWalletIsLinked && stakeBalance > 0n && !lockActive;
  const linkBusy = props.isBusy('wallet-link');
  const unlinkBusy = props.isBusy('wallet-unlink');
  const withdrawing = props.isBusy('stake-withdraw-tx');
  const confirming = props.isBusy('stake-withdraw-receipt');

  return {
    walletLabel: props.walletAddress ? truncateAddress(props.walletAddress) : null,
    linkedWalletLabel: props.walletLinkStatus ? truncateAddress(props.walletLinkStatus.wallet_address) : null,
    chainLabel: chainName(props.chainId),
    stakeBalanceLabel: props.stakeStatus ? `${props.stakeStatus.staked_balance_wei} wei` : 'No linked-wallet stake found',
    stakeLockLabel: stakeLockLabel(props.stakeStatus, stakeBalance, lockActive),
    linkDisabled: !props.walletAddress || linkBusy,
    linkLabel: linkBusy ? 'Linking...' : 'Link Wallet',
    unlinkDisabled: stakeBalance > 0n || unlinkBusy,
    unlinkLabel: unlinkLabel(unlinkBusy, stakeBalance),
    withdrawDisabled: !canWithdraw || withdrawing || confirming || props.isBusy('switch-chain'),
    withdrawLabel: withdrawLabel(confirming, withdrawing)
  };
}

function parseStakeBalance(stakeStatus: StakeStatusResponse | null): bigint {
  try {
    return BigInt(stakeStatus?.staked_balance_wei ?? '0');
  } catch {
    return 0n;
  }
}

function stakeLockIsActive(stakeStatus: StakeStatusResponse | null, stakeBalance: bigint, nowMs: number): boolean {
  const lockEndsAt = stakeStatus ? new Date(stakeStatus.unlock_time).getTime() : 0;
  return stakeBalance > 0n && lockEndsAt > nowMs;
}

function walletsMatch(walletAddress?: string, linkedWalletAddress?: string): boolean {
  return Boolean(
    walletAddress
    && linkedWalletAddress
    && walletAddress.toLowerCase() === linkedWalletAddress.toLowerCase()
  );
}

function stakeLockLabel(
  stakeStatus: StakeStatusResponse | null,
  stakeBalance: bigint,
  lockActive: boolean
): string {
  if (stakeBalance <= 0n || !stakeStatus) return 'No active stake';
  if (!lockActive) return 'Unlocked';
  return `Locked until ${new Date(stakeStatus.unlock_time).toLocaleString()}`;
}

function unlinkLabel(unlinkBusy: boolean, stakeBalance: bigint): string {
  if (unlinkBusy) return 'Unlinking...';
  return stakeBalance > 0n ? 'Withdraw Before Unlinking' : 'Unlink Wallet';
}

function withdrawLabel(confirming: boolean, withdrawing: boolean): string {
  if (confirming) return 'Confirming...';
  return withdrawing ? 'Submitting...' : 'Withdraw Stake';
}

function chainName(chainId?: number): string {
  if (!chainId) return 'Unknown';
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
