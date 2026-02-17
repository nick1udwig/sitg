import type { RepoSelection } from '../../state';
import type { InstallStatusResponse } from '../../types';

interface RepoInfoTabProps {
  selectedRepo: RepoSelection | null;
  installStatus: 'installed' | 'not-installed' | 'unknown';
  installDetails: InstallStatusResponse | null;
  installUrl: string;
}

const INSTALL_DOT: Record<string, string> = {
  installed: 'green',
  'not-installed': 'amber',
  unknown: 'gray'
};

export function RepoInfoTab({ selectedRepo, installStatus, installDetails, installUrl }: RepoInfoTabProps) {
  const ctaLabel = installStatus === 'installed' ? 'Configure App' : 'Install App';

  return (
    <article className="card">
      <h2>Repository Info</h2>
      <p className="meta">This is your selected repository. Install the GitHub App to enable PR gating.</p>

      <dl className="kv">
        <dt>Repository</dt>
        <dd>
          {selectedRepo
            ? `${selectedRepo.fullName} (${selectedRepo.id})`
            : <span style={{ color: 'var(--ink-soft)' }}>none selected</span>}
        </dd>
        <dt>Install status</dt>
        <dd>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-dot ${INSTALL_DOT[installStatus]}`} />
            {installStatus}
          </span>
        </dd>
        <dt>Installation ID</dt>
        <dd>{installDetails?.installation_id ?? <span style={{ color: 'var(--ink-soft)' }}>unknown</span>}</dd>
        <dt>Account</dt>
        <dd>{installDetails?.installation_account_login ?? <span style={{ color: 'var(--ink-soft)' }}>unknown</span>}</dd>
        <dt>Account type</dt>
        <dd>{installDetails?.installation_account_type ?? <span style={{ color: 'var(--ink-soft)' }}>unknown</span>}</dd>
      </dl>

      <div className="row-wrap">
        <a className="button-like" href={installUrl || '#'} target="_blank" rel="noreferrer">
          {ctaLabel}
        </a>
      </div>
    </article>
  );
}
