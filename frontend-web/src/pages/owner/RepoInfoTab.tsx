import type { RepoSelection } from '../../state';

interface RepoInfoTabProps {
  selectedRepo: RepoSelection | null;
  installStatus: 'installed' | 'not-installed' | 'unknown';
  installUrl: string;
}

const INSTALL_DOT: Record<string, string> = {
  installed: 'green',
  'not-installed': 'amber',
  unknown: 'gray'
};

export function RepoInfoTab({ selectedRepo, installStatus, installUrl }: RepoInfoTabProps) {
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
      </dl>

      <div className="row-wrap">
        <a className="button-like" href={installUrl || '#'} target="_blank" rel="noreferrer">
          Install App
        </a>
      </div>
    </article>
  );
}
