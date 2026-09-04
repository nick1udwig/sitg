import type { ReactNode } from 'react';
import type { GateResponse } from '../../types';

export interface GateViewModel {
  statusDot: string;
  statusBadge: string;
  countdown: string;
  countdownClass: string;
  thresholdUsdEstimate: string | null;
  stakeSummary: string;
  blockingMessage: string | null;
  readyMessage: string;
  hasGitHub: boolean;
  hasWallet: boolean;
  isConnectedWalletLinked: boolean;
  hasSufficientStake: boolean;
  linkButtonDisabled: boolean;
  linkButtonLabel: string;
  stakeButtonDisabled: boolean;
  stakeButtonLabel: string;
  confirmButtonDisabled: boolean;
  confirmButtonLabel: string;
  githubSignInDisabled: boolean;
  githubSignInLabel: string;
}

interface GateViewProps {
  gate: GateResponse;
  model: GateViewModel;
  onGitHubSignIn: () => void;
  onLinkWallet: () => void;
  onStake: () => void;
  onConfirm: () => void;
}

interface VerificationStepProps {
  complete: boolean;
  number: number;
  label: string;
  children?: ReactNode;
}

export function InvalidGateView() {
  return (
    <section className="card" style={{ maxWidth: 600, margin: '0 auto' }}>
      <h2>Contributor Gate</h2>
      <p className="error">Invalid gate URL.</p>
    </section>
  );
}

export function GateLoadingView({ error }: { error: string | null }) {
  if (error) {
    return (
      <section className="grid two">
        <article className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>PR Stake Gate</h2>
          <div className="error-bar">{error}</div>
        </article>
      </section>
    );
  }

  return (
    <section className="grid two">
      <article className="card"><p className="skeleton" /></article>
      <article className="card"><p className="skeleton" /></article>
    </section>
  );
}

export function GateView({
  gate,
  model,
  onGitHubSignIn,
  onLinkWallet,
  onStake,
  onConfirm
}: GateViewProps) {
  return (
    <section className="grid two">
      <GateDetailsCard gate={gate} model={model} />
      <GateVerificationCard
        model={model}
        onGitHubSignIn={onGitHubSignIn}
        onLinkWallet={onLinkWallet}
        onStake={onStake}
        onConfirm={onConfirm}
      />
    </section>
  );
}

function GateDetailsCard({ gate, model }: { gate: GateResponse; model: GateViewModel }) {
  return (
    <article className="card">
      <p className="meta" style={{ marginBottom: 4 }}>{gate.github_repo_full_name} &rsaquo; PR #{gate.github_pr_number}</p>
      <h2>PR Stake Gate</h2>
      <div className="gate-explainer" style={{ marginBottom: 12 }}>
        <p className="gate-explainer-title">{gate.github_repo_full_name} has been getting too many contributions.</p>
        <p className="gate-explainer-copy">To ensure your commitment, we ask you to temporarily post a bond of {model.thresholdUsdEstimate ?? 'an amount shown below'}.</p>
        <p className="gate-explainer-copy">
          You can reclaim your bond after 30 days at
          {' '}
          <a href="https://sitg.io/contributor" target="_blank" rel="noreferrer">sitg.io/contributor</a>.
        </p>
      </div>
      <span className={`badge ${model.statusBadge}`}>
        <span className={`status-dot ${model.statusDot}`} />
        {gate.status}
      </span>

      <div className={model.countdownClass} aria-live="polite" aria-label={`Time remaining ${model.countdown}`}>
        {model.countdown}
      </div>

      <dl className="kv">
        <dt>Author</dt>
        <dd>@{gate.github_pr_author_login}</dd>
        <dt>Head SHA</dt>
        <dd>{gate.head_sha.slice(0, 12)}</dd>
        <dt>Threshold (wei)</dt>
        <dd>{gate.threshold_wei_snapshot}</dd>
        <dt>Threshold (USD estimate)</dt>
        <dd>{model.thresholdUsdEstimate ?? 'Unavailable right now'}</dd>
        <dt>Stake</dt>
        <dd>{model.stakeSummary}</dd>
      </dl>
    </article>
  );
}

function GateVerificationCard({
  model,
  onGitHubSignIn,
  onLinkWallet,
  onStake,
  onConfirm
}: Omit<GateViewProps, 'gate'>) {
  return (
    <article className="card">
      <h3>Verification</h3>
      <GateReadinessMessage model={model} />
      <GitHubSignInAction model={model} onGitHubSignIn={onGitHubSignIn} />
      <div className="step-list">
        <VerificationStep complete={model.hasGitHub} number={1} label="Sign in with GitHub" />
        <VerificationStep complete={model.hasWallet} number={2} label="Connect wallet" />
        <VerificationStep complete={model.isConnectedWalletLinked} number={3} label="Link wallet to GitHub">
          <button
            className="ghost"
            style={{ marginLeft: 'auto', padding: '4px 10px' }}
            disabled={model.linkButtonDisabled}
            onClick={onLinkWallet}
          >
            {model.linkButtonLabel}
          </button>
        </VerificationStep>
        <VerificationStep complete={model.hasSufficientStake} number={4} label="Stake">
          <button
            className="ghost"
            style={{ marginLeft: 'auto', padding: '4px 10px' }}
            disabled={model.stakeButtonDisabled}
            onClick={onStake}
          >
            {model.stakeButtonLabel}
          </button>
        </VerificationStep>
        <VerificationStep complete={false} number={5} label="Sign PR confirmation">
          <button
            style={{ marginLeft: 'auto', padding: '4px 10px' }}
            disabled={model.confirmButtonDisabled}
            onClick={onConfirm}
          >
            {model.confirmButtonLabel}
          </button>
        </VerificationStep>
      </div>
    </article>
  );
}

function GateReadinessMessage({ model }: { model: GateViewModel }) {
  if (model.blockingMessage) {
    return <div className="error-bar">{model.blockingMessage}</div>;
  }
  return <div className="success-bar">{model.readyMessage}</div>;
}

function GitHubSignInAction({
  model,
  onGitHubSignIn
}: Pick<GateViewProps, 'model' | 'onGitHubSignIn'>) {
  if (model.hasGitHub) {
    return null;
  }
  return (
    <div className="row-wrap" style={{ marginTop: 8 }}>
      <button disabled={model.githubSignInDisabled} onClick={onGitHubSignIn}>
        {model.githubSignInLabel}
      </button>
    </div>
  );
}

function VerificationStep({ complete, number, label, children }: VerificationStepProps) {
  return (
    <div className="step">
      <span className={`step-indicator${complete ? ' done' : ''}`}>{complete ? '\u2713' : number}</span>
      <span className={`step-label${complete ? ' done' : ''}`}>{label}</span>
      {children}
    </div>
  );
}
