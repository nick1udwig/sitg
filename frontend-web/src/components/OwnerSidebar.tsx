import { FormEvent, useState } from 'react';
import type { RepoSelection } from '../state';
import type { RepoOption } from '../types';

interface OwnerSidebarProps {
  repoOptions: RepoOption[];
  recentRepos: RepoSelection[];
  selectedRepo: RepoSelection | null;
  onSelectRepo: (repo: RepoSelection) => void;
  onResolveRepoByFullName: (fullName: string) => Promise<RepoSelection | null>;
  onLogout: () => void;
  isBusy: (key: string) => boolean;
}

export function OwnerSidebar({
  repoOptions,
  recentRepos,
  selectedRepo,
  onSelectRepo,
  onResolveRepoByFullName,
  onLogout,
  isBusy
}: OwnerSidebarProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [repoNameInput, setRepoNameInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const normalizeRepoName = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const withoutProtocol = trimmed.replace(/^https?:\/\/github\.com\//i, '');
    const withoutPrefix = withoutProtocol.replace(/^github\.com\//i, '');
    return withoutPrefix.replace(/\/+$/, '').replace(/\.git$/i, '');
  };

  const merged = new Map<string, { id: string; fullName: string }>();
  for (const repo of repoOptions) {
    merged.set(String(repo.id), { id: String(repo.id), fullName: repo.full_name });
  }
  for (const repo of recentRepos) {
    if (!merged.has(repo.id)) {
      merged.set(repo.id, repo);
    }
  }
  const repoList = Array.from(merged.values());

  const handleAdd = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    let fullName = normalizeRepoName(repoNameInput);

    if (!fullName) {
      setAddError('Enter org/repo.');
      return;
    }

    const resolved = await onResolveRepoByFullName(fullName);
    if (!resolved) {
      setAddError('Unknown org/repo. It must be a repository you own.');
      return;
    }

    fullName = resolved.fullName;

    setAddError(null);
    onSelectRepo(resolved);
    setRepoNameInput('');
    setShowAdd(false);
  };

  return (
    <aside className="owner-sidebar">
      <div className="section-label" style={{ marginTop: 0 }}>
        Repositories
        <button
          className="ghost"
          style={{ float: 'right', padding: '0 6px', fontSize: 14, lineHeight: 1 }}
          onClick={() => setShowAdd(!showAdd)}
          aria-label="Add repository"
        >
          +
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} style={{ marginBottom: 8 }}>
          <input
            placeholder="org/repo"
            value={repoNameInput}
            onChange={(e) => {
              setRepoNameInput(e.target.value);
              if (addError) setAddError(null);
            }}
            aria-label="Full name"
          />
          <button type="submit" style={{ padding: '4px 10px' }} disabled={isBusy('resolve-repo')}>
            {isBusy('resolve-repo') ? 'Adding...' : 'Add'}
          </button>
          {addError && (
            <p style={{ margin: '6px 0 0', color: 'var(--danger, #d64545)', fontSize: 12 }}>
              {addError}
            </p>
          )}
        </form>
      )}

      <ul className="owner-sidebar-list">
        {repoList.map((repo) => (
          <li key={repo.id}>
            <button
              className={`owner-sidebar-item${selectedRepo?.id === repo.id ? ' active' : ''}`}
              onClick={() => onSelectRepo(repo)}
            >
              {repo.fullName}
            </button>
          </li>
        ))}
        {repoList.length === 0 && (
          <li>
            <span className="owner-sidebar-item" style={{ cursor: 'default', color: 'var(--ink-soft)' }}>
              No repositories yet
            </span>
          </li>
        )}
      </ul>

      <div className="owner-sidebar-bottom">
        <button className="ghost" style={{ width: '100%' }} disabled={isBusy('logout')} onClick={onLogout}>
          {isBusy('logout') ? 'Signing out...' : 'Sign out'}
        </button>
      </div>
    </aside>
  );
}
