import { FormEvent, useState } from 'react';
import type { RepoSelection } from '../state';
import type { RepoOption } from '../types';

interface OwnerSidebarProps {
  repoOptions: RepoOption[];
  recentRepos: RepoSelection[];
  selectedRepo: RepoSelection | null;
  onSelectRepo: (repo: RepoSelection) => void;
  onResolveRepoByFullName: (fullName: string) => Promise<RepoSelection | null>;
  isBusy: (key: string) => boolean;
}

export function OwnerSidebar({
  repoOptions,
  recentRepos,
  selectedRepo,
  onSelectRepo,
  onResolveRepoByFullName,
  isBusy
}: OwnerSidebarProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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
        <span style={{ float: 'right', display: 'inline-flex', gap: 4 }}>
          <button
            className="ghost"
            style={{ padding: '0 6px', fontSize: 14, lineHeight: 1 }}
            onClick={() => {
              setShowSearch(!showSearch);
              if (showSearch) setSearchQuery('');
            }}
            aria-label="Search repositories"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            className="ghost"
            style={{ padding: '0 6px', fontSize: 14, lineHeight: 1 }}
            onClick={() => setShowAdd(!showAdd)}
            aria-label="Add repository"
          >
            +
          </button>
        </span>
      </div>

      {showSearch && (
        <input
          placeholder="Filter repos..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search repositories"
          style={{ marginBottom: 8 }}
          autoFocus
        />
      )}

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
        {(searchQuery
          ? repoList.filter((r) => r.fullName.toLowerCase().includes(searchQuery.toLowerCase()))
          : repoList
        ).map((repo) => (
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
    </aside>
  );
}
