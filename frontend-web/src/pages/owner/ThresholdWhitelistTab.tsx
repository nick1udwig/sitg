import type { FormEvent } from 'react';
import type { RepoSelection } from '../../state';
import type { InputMode } from '../../types';

interface ConfigFormState {
  inputMode: InputMode;
  inputValue: string;
  draftPrsGated: boolean;
}

interface ThresholdWhitelistTabProps {
  selectedRepo: RepoSelection | null;
  installStatus: 'installed' | 'not-installed' | 'unknown';
  configForm: ConfigFormState;
  onConfigFormChange: (updater: (prev: ConfigFormState) => ConfigFormState) => void;
  summary: { enforcedEth: string; usdEstimate: string };
  whitelistInput: string;
  onWhitelistInputChange: (value: string) => void;
  onSaveConfig: (event: FormEvent<HTMLFormElement>) => void;
  onSaveWhitelist: (event: FormEvent<HTMLFormElement>) => void;
  isBusy: (key: string) => boolean;
  isAuthed: boolean;
  loadingConfig: boolean;
}

const INSTALL_DOT: Record<string, string> = {
  installed: 'green',
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
  onWhitelistInputChange,
  onSaveConfig,
  onSaveWhitelist,
  isBusy,
  isAuthed,
  loadingConfig
}: ThresholdWhitelistTabProps) {
  return (
    <div className="grid two">
      <article className="card">
        <h2>Threshold Configuration</h2>
        <p className="meta">Set the ETH stake required from contributors. Whitelisted users bypass the gate.</p>

        {loadingConfig ? <p className="skeleton" aria-label="Loading repo config" /> : null}

        <form onSubmit={onSaveConfig}>
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
          <button type="submit" disabled={isBusy('save-config') || !selectedRepo || !isAuthed}>
            {isBusy('save-config') ? 'Saving...' : 'Save Config'}
          </button>
        </form>
      </article>

      <article className="card">
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
              {installStatus}
            </span>
          </dd>
          <dt>Enforced ETH</dt>
          <dd style={{ color: 'var(--accent)' }}>{summary.enforcedEth}</dd>
          <dt>USD estimate</dt>
          <dd><span style={{ color: 'var(--ink-soft)' }}>{summary.usdEstimate} (estimate)</span></dd>
        </dl>

        <div className="section-label">Whitelist</div>
        <form onSubmit={onSaveWhitelist}>
          <label>
            GitHub logins (comma separated)
            <textarea
              value={whitelistInput}
              onChange={(event) => onWhitelistInputChange(event.target.value)}
              placeholder="alice, bob"
            />
          </label>
          <button type="submit" disabled={isBusy('save-whitelist') || !selectedRepo || !isAuthed}>
            {isBusy('save-whitelist') ? 'Saving...' : 'Resolve + Save Whitelist'}
          </button>
        </form>
      </article>
    </div>
  );
}
