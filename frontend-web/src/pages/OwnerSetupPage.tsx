import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  createBotClient,
  createBotClientKey,
  getInstallStatus,
  getOwnedRepos,
  getRepoConfig,
  githubSignIn,
  listBotClients,
  logout,
  putRepoConfig,
  putWhitelist,
  resolveWhitelistLogins,
  revokeBotClientKey,
  setBotInstallationBindings
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { useAppState } from '../state';
import type { BotClient, InputMode, RepoConfigResponse, RepoOption } from '../types';

interface RepoConfigFormState {
  inputMode: InputMode;
  inputValue: string;
  draftPrsGated: boolean;
}

const DEFAULT_FORM: RepoConfigFormState = {
  inputMode: 'ETH',
  inputValue: '0.10',
  draftPrsGated: true
};

const INSTALL_DOT: Record<string, string> = {
  installed: 'green',
  'not-installed': 'amber',
  unknown: 'gray'
};

export function OwnerSetupPage() {
  const { state, setRepo, runBusy, isBusy, pushNotice } = useAppState();
  const [repoIdInput, setRepoIdInput] = useState(state.selectedRepo?.id ?? '');
  const [repoNameInput, setRepoNameInput] = useState(state.selectedRepo?.fullName ?? '');
  const [config, setConfig] = useState<RepoConfigResponse | null>(null);
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [installStatus, setInstallStatus] = useState<'installed' | 'not-installed' | 'unknown'>('unknown');
  const [configForm, setConfigForm] = useState<RepoConfigFormState>(DEFAULT_FORM);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);

  const [botClients, setBotClients] = useState<BotClient[]>([]);
  const [selectedBotClientId, setSelectedBotClientId] = useState('');
  const [newBotClientName, setNewBotClientName] = useState('');
  const [bindingsInput, setBindingsInput] = useState('');
  const [revokeKeyId, setRevokeKeyId] = useState('');
  const [createdKeySecret, setCreatedKeySecret] = useState<string | null>(null);

  const selectedRepo = state.selectedRepo;

  async function refreshBotClients(): Promise<void> {
    const clients = await listBotClients();
    if (!clients) {
      setBotClients([]);
      setSelectedBotClientId('');
      return;
    }
    setBotClients(clients);
    if (clients.length && !selectedBotClientId) {
      setSelectedBotClientId(clients[0].id);
    }
  }

  useEffect(() => {
    if (!state.me) {
      setRepoOptions([]);
      setBotClients([]);
      return;
    }

    let mounted = true;
    void Promise.all([getOwnedRepos(), listBotClients()])
      .then(([repos, clients]) => {
        if (!mounted) {
          return;
        }
        if (repos) {
          setRepoOptions(repos);
        }
        if (clients) {
          setBotClients(clients);
          setSelectedBotClientId((prev) => (prev || (clients.length ? clients[0].id : '')));
        }
      })
      .catch((error) => {
        if (mounted) {
          pushNotice('error', toUserMessage(error));
        }
      });

    return () => {
      mounted = false;
    };
  }, [state.me, pushNotice]);

  useEffect(() => {
    if (!selectedRepo || !state.me) {
      setConfig(null);
      setInstallStatus('unknown');
      return;
    }

    let mounted = true;
    setLoadingConfig(true);

    void Promise.all([getRepoConfig(selectedRepo.id).catch(() => null), getInstallStatus(selectedRepo.id).catch(() => null)])
      .then(([repoConfig, install]) => {
        if (!mounted) {
          return;
        }

        if (repoConfig) {
          setConfig(repoConfig);
          setConfigForm({
            inputMode: repoConfig.threshold.input_mode,
            inputValue: repoConfig.threshold.input_value,
            draftPrsGated: repoConfig.draft_prs_gated
          });
        } else {
          setConfig(null);
          pushNotice('info', `No existing config yet for repo ${selectedRepo.id}. Save to create one.`);
        }

        if (install) {
          setInstallStatus(install.installed ? 'installed' : 'not-installed');
        } else {
          setInstallStatus('unknown');
        }
      })
      .catch((error) => {
        if (mounted) {
          pushNotice('error', toUserMessage(error));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingConfig(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selectedRepo, state.me, pushNotice]);

  const summary = useMemo(() => {
    if (!config) {
      return {
        enforcedEth: configForm.inputMode === 'ETH' ? configForm.inputValue : 'pending',
        usdEstimate: 'pending'
      };
    }

    return {
      enforcedEth: config.threshold.eth,
      usdEstimate: config.threshold.usd_estimate
    };
  }, [config, configForm]);

  const handleSelectRepo = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalizedId = repoIdInput.trim();
    if (!/^\d+$/.test(normalizedId)) {
      pushNotice('error', 'Repo ID must be numeric.');
      return;
    }

    const normalizedName = repoNameInput.trim() || `repo/${normalizedId}`;
    setRepo({ id: normalizedId, fullName: normalizedName });
    pushNotice('success', `Selected repository ${normalizedName} (${normalizedId}).`);
  };

  const handleSaveConfig = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!selectedRepo) {
      pushNotice('error', 'Select a repository first.');
      return;
    }

    const result = await runBusy('save-config', async () =>
      putRepoConfig(selectedRepo.id, {
        input_mode: configForm.inputMode,
        input_value: configForm.inputValue,
        draft_prs_gated: configForm.draftPrsGated
      })
    );

    if (!result) {
      pushNotice('error', 'Saving config failed.');
      return;
    }

    setConfig(result);
    pushNotice('success', `Saved config for ${selectedRepo.fullName}. Enforced ETH: ${result.threshold.eth}.`);
  };

  const handleSaveWhitelist = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!selectedRepo) {
      pushNotice('error', 'Select a repository first.');
      return;
    }

    const logins = whitelistInput
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!logins.length) {
      pushNotice('info', 'Provide at least one GitHub login.');
      return;
    }

    const resolved = await runBusy('save-whitelist', () => resolveWhitelistLogins(selectedRepo.id, logins));
    if (!resolved) {
      pushNotice('error', 'Whitelist login resolution failed.');
      return;
    }

    const saved = await runBusy('save-whitelist', async () => {
      await putWhitelist(selectedRepo.id, resolved.resolved);
      return true;
    });

    if (!saved) {
      pushNotice('error', 'Whitelist save failed.');
      return;
    }

    setWhitelistInput('');
    pushNotice(
      'success',
      `Saved ${resolved.resolved.length} whitelist entries. Unresolved: ${resolved.unresolved.join(', ') || 'none'}.`
    );
  };

  const handleLogout = async (): Promise<void> => {
    const ok = await runBusy('logout', async () => {
      await logout();
      return true;
    });
    if (ok) {
      window.location.href = '/';
    }
  };

  const handleCreateBotClient = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = newBotClientName.trim();
    if (!name) {
      pushNotice('error', 'Bot client name is required.');
      return;
    }

    const created = await runBusy('bot-client-create', () => createBotClient(name));
    if (!created) {
      pushNotice('error', 'Failed to create bot client.');
      return;
    }

    setNewBotClientName('');
    setSelectedBotClientId(created.id);
    await refreshBotClients();
    pushNotice('success', `Created bot client ${created.name}.`);
  };

  const handleCreateBotKey = async (): Promise<void> => {
    if (!selectedBotClientId) {
      pushNotice('error', 'Select a bot client first.');
      return;
    }

    const created = await runBusy('bot-key-create', () => createBotClientKey(selectedBotClientId));
    if (!created) {
      pushNotice('error', 'Failed to create bot key.');
      return;
    }

    setCreatedKeySecret(created.secret);
    await refreshBotClients();
    pushNotice('success', `Created key ${created.key_id}. Secret shown once below.`);
  };

  const handleRevokeBotKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedBotClientId || !revokeKeyId.trim()) {
      pushNotice('error', 'Select bot client and key id to revoke.');
      return;
    }

    const result = await runBusy('bot-key-revoke', async () => {
      await revokeBotClientKey(selectedBotClientId, revokeKeyId.trim());
      return true;
    });

    if (!result) {
      pushNotice('error', 'Failed to revoke key.');
      return;
    }

    setRevokeKeyId('');
    await refreshBotClients();
    pushNotice('success', 'Bot key revoked.');
  };

  const handleSaveBindings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedBotClientId) {
      pushNotice('error', 'Select a bot client first.');
      return;
    }

    const installationIds = bindingsInput
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    const result = await runBusy('bot-bindings-save', async () => {
      await setBotInstallationBindings(selectedBotClientId, installationIds);
      return true;
    });

    if (!result) {
      pushNotice('error', 'Failed to save installation bindings.');
      return;
    }

    await refreshBotClients();
    pushNotice('success', 'Installation bindings saved.');
  };

  const installUrl = import.meta.env.VITE_GITHUB_APP_INSTALL_URL ?? '';
  const selectedBotClient = botClients.find((client) => client.id === selectedBotClientId) ?? null;

  return (
    <section className="grid two">
      {/* ── Left column: Repository ── */}
      <article className="card">
        <h2>Repository</h2>
        <p className="meta">Connect GitHub, install app, pick repo, configure thresholds.</p>

        {!state.me ? (
          <div className="grid">
            <button
            disabled={isBusy('github-sign-in')}
            onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
            aria-label="Sign in with GitHub"
          >
            {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in with GitHub'}
          </button>
            <p className="meta" style={{ marginBottom: 0 }}>Sign-in is required for owner configuration APIs.</p>
          </div>
        ) : (
          <>
            <div className="section-label">Authentication</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span className="status-dot green" />
              <span className="mono">@{state.me.github_login}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                <span className={`status-dot ${INSTALL_DOT[installStatus]}`} />
                <span className="meta" style={{ margin: 0 }}>{installStatus}</span>
              </span>
              <div className="row-wrap" style={{ marginLeft: 'auto' }}>
                <a className="button-like" href={installUrl || '#'} target="_blank" rel="noreferrer">
                  Install App
                </a>
                <button className="ghost" disabled={isBusy('logout')} onClick={handleLogout}>
                  {isBusy('logout') ? 'Signing out...' : 'Sign out'}
                </button>
              </div>
            </div>
          </>
        )}

        <div className="section-label">Select Repository</div>
        <form onSubmit={handleSelectRepo}>
          <div className="form-row">
            <label>
              Repo ID
              <input
                id="repo-id"
                value={repoIdInput}
                onChange={(event) => setRepoIdInput(event.target.value)}
                placeholder="123456"
              />
            </label>
            <label>
              Full name
              <input
                id="repo-name"
                value={repoNameInput}
                onChange={(event) => setRepoNameInput(event.target.value)}
                placeholder="org/repo"
              />
            </label>
          </div>
          <div className="form-row">
            <button type="submit">Use Repository</button>
            <select
              aria-label="Owned repositories"
              value={selectedRepo?.id ?? ''}
              onChange={(event) => {
                const selectedFromOwned = repoOptions.find((repo) => String(repo.id) === event.target.value);
                if (selectedFromOwned) {
                  const mapped = { id: String(selectedFromOwned.id), fullName: selectedFromOwned.full_name };
                  setRepo(mapped);
                  setRepoIdInput(mapped.id);
                  setRepoNameInput(mapped.fullName);
                  return;
                }

                const selectedFromRecent = state.recentRepos.find((repo) => repo.id === event.target.value);
                if (selectedFromRecent) {
                  setRepo(selectedFromRecent);
                  setRepoIdInput(selectedFromRecent.id);
                  setRepoNameInput(selectedFromRecent.fullName);
                }
              }}
            >
              <option value="">Owned / recent repos</option>
              {repoOptions.map((repo) => (
                <option key={repo.id} value={String(repo.id)}>
                  {repo.full_name} ({repo.id})
                </option>
              ))}
              {state.recentRepos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullName} ({repo.id})
                </option>
              ))}
            </select>
          </div>
        </form>

        <div className="section-label">Threshold Configuration</div>

        {loadingConfig ? <p className="skeleton" aria-label="Loading repo config" /> : null}

        <form onSubmit={handleSaveConfig}>
          <div className="form-row">
            <label>
              Input mode
              <select
                value={configForm.inputMode}
                onChange={(event) => setConfigForm((prev) => ({ ...prev, inputMode: event.target.value as InputMode }))}
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
                onChange={(event) => setConfigForm((prev) => ({ ...prev, inputValue: event.target.value }))}
              />
            </label>
            <label>
              Draft gated
              <select
                value={String(configForm.draftPrsGated)}
                onChange={(event) =>
                  setConfigForm((prev) => ({ ...prev, draftPrsGated: event.target.value === 'true' }))
                }
              >
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </label>
          </div>
          <button type="submit" disabled={isBusy('save-config') || !selectedRepo || !state.me}>
            {isBusy('save-config') ? 'Saving...' : 'Save Config'}
          </button>
        </form>
      </article>

      {/* ── Right column: Config summary + Whitelist ── */}
      <article className="card">
        <h3>Threshold &amp; Whitelist</h3>

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
        <form onSubmit={handleSaveWhitelist}>
          <label>
            GitHub logins (comma separated)
            <textarea
              value={whitelistInput}
              onChange={(event) => setWhitelistInput(event.target.value)}
              placeholder="alice, bob"
            />
          </label>
          <button type="submit" disabled={isBusy('save-whitelist') || !selectedRepo || !state.me}>
            {isBusy('save-whitelist') ? 'Saving...' : 'Resolve + Save Whitelist'}
          </button>
        </form>
      </article>

      {/* ── Bot Clients (full-width) ── */}
      <article className="card" style={{ gridColumn: '1 / -1' }}>
        <h3>Bot Clients</h3>
        <p className="meta">Create bot clients, issue/revoke keys, and bind installations.</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div className="section-label">Create Client</div>
            <form onSubmit={handleCreateBotClient}>
              <label>
                Name
                <input
                  value={newBotClientName}
                  onChange={(event) => setNewBotClientName(event.target.value)}
                  placeholder="acme-prod-bot"
                />
              </label>
              <button type="submit" disabled={isBusy('bot-client-create') || !state.me}>
                {isBusy('bot-client-create') ? 'Creating...' : 'Create Bot Client'}
              </button>
            </form>

            <div className="section-label">Select Client</div>
            <label>
              Active client
              <select
                value={selectedBotClientId}
                onChange={(event) => {
                  setSelectedBotClientId(event.target.value);
                  const next = botClients.find((client) => client.id === event.target.value);
                  setBindingsInput((next?.installation_ids ?? []).join(', '));
                }}
              >
                <option value="">Select client</option>
                {botClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name} ({client.id})
                  </option>
                ))}
              </select>
            </label>

            <dl className="kv">
              <dt>Selected bot</dt>
              <dd>{selectedBotClient ? selectedBotClient.name : <span style={{ color: 'var(--ink-soft)' }}>none</span>}</dd>
              <dt>Key count</dt>
              <dd>{selectedBotClient?.keys?.length ?? 0}</dd>
              <dt>Installations</dt>
              <dd>{selectedBotClient?.installation_ids?.join(', ') || <span style={{ color: 'var(--ink-soft)' }}>none</span>}</dd>
            </dl>
          </div>

          <div>
            <div className="section-label">Keys</div>
            <div className="row-wrap" style={{ marginBottom: 12 }}>
              <button onClick={handleCreateBotKey} disabled={!selectedBotClientId || isBusy('bot-key-create')}>
                {isBusy('bot-key-create') ? 'Creating...' : 'Create Key'}
              </button>
            </div>

            {createdKeySecret ? (
              <div className="notice" aria-live="polite" style={{ marginBottom: 12 }}>
                <span className="meta" style={{ margin: 0 }}>Secret (shown once):</span>
                <code className="mono" style={{ display: 'block', marginTop: 4, wordBreak: 'break-all' }}>
                  {createdKeySecret}
                </code>
              </div>
            ) : null}

            <form onSubmit={handleRevokeBotKey}>
              <label>
                Revoke key ID
                <input value={revokeKeyId} onChange={(event) => setRevokeKeyId(event.target.value)} placeholder="bck_live_abc123" />
              </label>
              <button type="submit" className="warn" disabled={!selectedBotClientId || isBusy('bot-key-revoke')}>
                {isBusy('bot-key-revoke') ? 'Revoking...' : 'Revoke Key'}
              </button>
            </form>

            <div className="section-label">Installation Bindings</div>
            <form onSubmit={handleSaveBindings}>
              <label>
                Installation IDs (comma separated)
                <textarea
                  value={bindingsInput}
                  onChange={(event) => setBindingsInput(event.target.value)}
                  placeholder="100, 101"
                />
              </label>
              <button type="submit" disabled={!selectedBotClientId || isBusy('bot-bindings-save')}>
                {isBusy('bot-bindings-save') ? 'Saving...' : 'Save Bindings'}
              </button>
            </form>
          </div>
        </div>
      </article>
    </section>
  );
}
