import type { FormEvent } from 'react';
import type { RepoSelection } from '../../state';
import type { InputMode, WhitelistEntry } from '../../types';

interface ConfigFormState {
  inputMode: InputMode;
  inputValue: string;
  draftPrsGated: boolean;
}

interface ThresholdWhitelistTabProps {
  selectedRepo: RepoSelection | null;
  installStatus: 'connected' | 'not-connected' | 'not-installed' | 'unknown';
  configForm: ConfigFormState;
  onConfigFormChange: (updater: (prev: ConfigFormState) => ConfigFormState) => void;
  summary: { enforcedEth: string; usdEstimate: string };
  whitelistInput: string;
  whitelistEntries: WhitelistEntry[];
  onWhitelistInputChange: (value: string) => void;
  onSaveConfig: (event: FormEvent<HTMLFormElement>) => void;
  onSaveWhitelist: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteWhitelistEntry: (entry: WhitelistEntry) => void;
  isBusy: (key: string) => boolean;
  isAuthed: boolean;
  loadingConfig: boolean;
}

const INSTALL_DOT: Record<string, string> = {
  connected: 'green',
  'not-connected': 'amber',
  'not-installed': 'amber',
  unknown: 'gray'
};

export function ThresholdWhitelistTab({
  selectedRepo,
  installStatus,
  configForm,
  onConfigFormChange,
  summary,
  whitelistInput,
  whitelistEntries,
  onWhitelistInputChange,
  onSaveConfig,
  onSaveWhitelist,
  onDeleteWhitelistEntry,
  isBusy,
  isAuthed,
  loadingConfig
}: ThresholdWhitelistTabProps) {
  const repoConnected = installStatus === 'connected';
  const saveConfigDisabled = loadingConfig || isBusy('save-config') || !selectedRepo || !isAuthed || !repoConnected;
  const saveWhitelistDisabled = loadingConfig || isBusy('save-whitelist') || !selectedRepo || !isAuthed || !repoConnected;
  const cardsLocked = !repoConnected;
  const connectionHelp = installStatus === 'not-connected'
    ? 'Connect this repository in the GitHub App to unlock Threshold and Whitelist settings.'
    : 'Install the GitHub App to unlock Threshold and Whitelist settings.';

  return (
    <div className="grid two">
      {cardsLocked ? (
        <div className="install-required-banner" role="status" aria-live="polite">
          <span className="status-dot amber" />
          {connectionHelp}
        </div>
      ) : null}

      <article className={`card${cardsLocked ? ' app-locked' : ''}`}>
        <h2>Threshold Configuration</h2>
        <p className="meta">Set the ETH stake required from contributors. Whitelisted users bypass the gate.</p>

        {loadingConfig ? <p className="skeleton" aria-label="Loading repo config" /> : null}

        <form onSubmit={onSaveConfig}>
          <fieldset className="form-lockset" disabled={cardsLocked}>
            <div className="form-row">
              <label>
                Input mode
                <select
                  value={configForm.inputMode}
                  onChange={(event) => onConfigFormChange((prev) => ({ ...prev, inputMode: event.target.value as InputMode }))}
                >
                  <option value="ETH">ETH</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label>
                Value
                <input
                  required
                  value={configForm.inputValue}
                  onChange={(event) => onConfigFormChange((prev) => ({ ...prev, inputValue: event.target.value }))}
                />
              </label>
              <label>
                Draft gated
                <select
                  value={String(configForm.draftPrsGated)}
                  onChange={(event) =>
                    onConfigFormChange((prev) => ({ ...prev, draftPrsGated: event.target.value === 'true' }))
                  }
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              </label>
            </div>
            <button type="submit" disabled={saveConfigDisabled}>
              {isBusy('save-config') ? 'Saving...' : 'Save Config'}
            </button>
          </fieldset>
        </form>
      </article>

      <article className={`card${cardsLocked ? ' app-locked' : ''}`}>
        <h3>Summary &amp; Whitelist</h3>

        <div className="info-bar">
          <strong>Enforcement is in ETH.</strong> USD value is an estimate at config time.
        </div>

        <dl className="kv">
          <dt>Selected repo</dt>
          <dd>{selectedRepo ? `${selectedRepo.fullName} (${selectedRepo.id})` : <span style={{ color: 'var(--ink-soft)' }}>none</span>}</dd>
          <dt>Install status</dt>
          <dd>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={`status-dot ${INSTALL_DOT[installStatus]}`} />
              {installStatus.replaceAll('-', ' ')}
            </span>
          </dd>
          <dt>Enforced ETH</dt>
          <dd style={{ color: 'var(--accent)' }}>{summary.enforcedEth}</dd>
          <dt>USD estimate</dt>
          <dd><span style={{ color: 'var(--ink-soft)' }}>{summary.usdEstimate} (estimate)</span></dd>
        </dl>

        <div className="section-label">Whitelist</div>
        {whitelistEntries.length ? (
          <ul className="whitelist-list" aria-label="Current whitelist">
            {whitelistEntries.map((entry) => (
              <li key={entry.github_user_id}>
                <span>@{entry.github_login}</span>
                <button
                  type="button"
                  className="ghost"
                  disabled={cardsLocked || isBusy(`delete-whitelist-${entry.github_user_id}`)}
                  onClick={() => onDeleteWhitelistEntry(entry)}
                  aria-label={`Remove ${entry.github_login} from whitelist`}
                >
                  {isBusy(`delete-whitelist-${entry.github_user_id}`) ? 'Removing...' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="meta">No contributors are currently whitelisted.</p>
        )}
        <form onSubmit={onSaveWhitelist}>
          <fieldset className="form-lockset" disabled={cardsLocked}>
            <label>
              GitHub logins (comma separated)
              <textarea
                value={whitelistInput}
                onChange={(event) => onWhitelistInputChange(event.target.value)}
                placeholder="alice, bob"
              />
            </label>
            <button type="submit" disabled={saveWhitelistDisabled}>
              {isBusy('save-whitelist') ? 'Saving...' : 'Resolve + Save Whitelist'}
            </button>
          </fieldset>
        </form>
      </article>
    </div>
  );
}
