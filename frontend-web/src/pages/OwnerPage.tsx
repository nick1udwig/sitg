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
import { OwnerSidebar } from '../components/OwnerSidebar';
import { OwnerTabs } from '../components/OwnerTabs';
import type { OwnerTabId } from '../components/OwnerTabs';
import { RepoInfoTab } from './owner/RepoInfoTab';
import { ThresholdWhitelistTab } from './owner/ThresholdWhitelistTab';
import { GitHubBotTab } from './owner/GitHubBotTab';
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

export function OwnerPage() {
  const { state, setRepo, runBusy, isBusy, pushNotice } = useAppState();
  const [config, setConfig] = useState<RepoConfigResponse | null>(null);
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [installStatus, setInstallStatus] = useState<'installed' | 'not-installed' | 'unknown'>('unknown');
  const [configForm, setConfigForm] = useState<RepoConfigFormState>(DEFAULT_FORM);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [activeTab, setActiveTab] = useState<OwnerTabId>('repo-info');

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
        if (!mounted) return;
        if (repos) setRepoOptions(repos);
        if (clients) {
          setBotClients(clients);
          setSelectedBotClientId((prev) => (prev || (clients.length ? clients[0].id : '')));
        }
      })
      .catch((error) => {
        if (mounted) pushNotice('error', toUserMessage(error));
      });

    return () => { mounted = false; };
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
        if (!mounted) return;

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
        if (mounted) pushNotice('error', toUserMessage(error));
      })
      .finally(() => {
        if (mounted) setLoadingConfig(false);
      });

    return () => { mounted = false; };
  }, [selectedRepo, state.me, pushNotice]);

  const summary = useMemo(() => {
    if (!config) {
      return {
        enforcedEth: configForm.inputMode === 'ETH' ? configForm.inputValue : 'pending',
        usdEstimate: 'pending'
      };
    }
    return { enforcedEth: config.threshold.eth, usdEstimate: config.threshold.usd_estimate };
  }, [config, configForm]);

  const handleSaveConfig = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedRepo) { pushNotice('error', 'Select a repository first.'); return; }

    const result = await runBusy('save-config', async () =>
      putRepoConfig(selectedRepo.id, {
        input_mode: configForm.inputMode,
        input_value: configForm.inputValue,
        draft_prs_gated: configForm.draftPrsGated
      })
    );

    if (!result) { pushNotice('error', 'Saving config failed.'); return; }
    setConfig(result);
    pushNotice('success', `Saved config for ${selectedRepo.fullName}. Enforced ETH: ${result.threshold.eth}.`);
  };

  const handleSaveWhitelist = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedRepo) { pushNotice('error', 'Select a repository first.'); return; }

    const logins = whitelistInput.split(',').map((v) => v.trim()).filter(Boolean);
    if (!logins.length) { pushNotice('info', 'Provide at least one GitHub login.'); return; }

    const resolved = await runBusy('save-whitelist', () => resolveWhitelistLogins(selectedRepo.id, logins));
    if (!resolved) { pushNotice('error', 'Whitelist login resolution failed.'); return; }

    const saved = await runBusy('save-whitelist', async () => {
      await putWhitelist(selectedRepo.id, resolved.resolved);
      return true;
    });

    if (!saved) { pushNotice('error', 'Whitelist save failed.'); return; }
    setWhitelistInput('');
    pushNotice('success', `Saved ${resolved.resolved.length} whitelist entries. Unresolved: ${resolved.unresolved.join(', ') || 'none'}.`);
  };

  const handleLogout = async (): Promise<void> => {
    const ok = await runBusy('logout', async () => { await logout(); return true; });
    if (ok) window.location.href = '/';
  };

  const handleResolveRepoByFullName = async (fullName: string): Promise<{ id: string; fullName: string } | null> => {
    const normalized = fullName.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const fromCurrent = repoOptions.find((repo) => repo.full_name.toLowerCase() === normalized);
    if (fromCurrent) {
      return { id: String(fromCurrent.id), fullName: fromCurrent.full_name };
    }

    const refreshed = await runBusy('resolve-repo', () => getOwnedRepos());
    if (!refreshed) {
      return null;
    }
    setRepoOptions(refreshed);

    const fromRefreshed = refreshed.find((repo) => repo.full_name.toLowerCase() === normalized);
    if (!fromRefreshed) {
      return null;
    }
    return { id: String(fromRefreshed.id), fullName: fromRefreshed.full_name };
  };

  const handleCreateBotClient = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = newBotClientName.trim();
    if (!name) { pushNotice('error', 'Bot client name is required.'); return; }

    const created = await runBusy('bot-client-create', () => createBotClient(name));
    if (!created) { pushNotice('error', 'Failed to create bot client.'); return; }

    setNewBotClientName('');
    setSelectedBotClientId(created.id);
    await refreshBotClients();
    pushNotice('success', `Created bot client ${created.name}.`);
  };

  const handleCreateBotKey = async (): Promise<void> => {
    if (!selectedBotClientId) { pushNotice('error', 'Select a bot client first.'); return; }

    const created = await runBusy('bot-key-create', () => createBotClientKey(selectedBotClientId));
    if (!created) { pushNotice('error', 'Failed to create bot key.'); return; }

    setCreatedKeySecret(created.secret);
    await refreshBotClients();
    pushNotice('success', `Created key ${created.key_id}. Secret shown once below.`);
  };

  const handleRevokeBotKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedBotClientId || !revokeKeyId.trim()) { pushNotice('error', 'Select bot client and key id to revoke.'); return; }

    const result = await runBusy('bot-key-revoke', async () => {
      await revokeBotClientKey(selectedBotClientId, revokeKeyId.trim());
      return true;
    });

    if (!result) { pushNotice('error', 'Failed to revoke key.'); return; }
    setRevokeKeyId('');
    await refreshBotClients();
    pushNotice('success', 'Bot key revoked.');
  };

  const handleSaveBindings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedBotClientId) { pushNotice('error', 'Select a bot client first.'); return; }

    const installationIds = bindingsInput.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0);

    const result = await runBusy('bot-bindings-save', async () => {
      await setBotInstallationBindings(selectedBotClientId, installationIds);
      return true;
    });

    if (!result) { pushNotice('error', 'Failed to save installation bindings.'); return; }
    await refreshBotClients();
    pushNotice('success', 'Installation bindings saved.');
  };

  const handleSelectBotClient = (id: string): void => {
    setSelectedBotClientId(id);
    const next = botClients.find((client) => client.id === id);
    setBindingsInput((next?.installation_ids ?? []).join(', '));
  };

  const installUrl = import.meta.env.VITE_GITHUB_APP_INSTALL_URL ?? '';

  if (!state.me) {
    return (
      <div className="auth-prompt">
        <div className="landing-brand">sitg</div>
        <p className="auth-prompt-desc">
          Sign in with GitHub to configure repositories, set stake thresholds, and manage bot clients.
        </p>
        <button
          disabled={isBusy('github-sign-in')}
          onClick={() => runBusy('github-sign-in', () => githubSignIn(window.location.href))}
          aria-label="Sign in with GitHub"
        >
          {isBusy('github-sign-in') ? 'Redirecting...' : 'Sign in with GitHub'}
        </button>
      </div>
    );
  }

  return (
    <div className="owner-shell">
      <OwnerSidebar
        repoOptions={repoOptions}
        recentRepos={state.recentRepos}
        selectedRepo={selectedRepo}
        onSelectRepo={setRepo}
        onResolveRepoByFullName={handleResolveRepoByFullName}
        onLogout={handleLogout}
        isBusy={isBusy}
      />
      <main>
        <OwnerTabs active={activeTab} onSelect={setActiveTab} />
        {activeTab === 'repo-info' && (
          <RepoInfoTab
            selectedRepo={selectedRepo}
            installStatus={installStatus}
            installUrl={installUrl}
          />
        )}
        {activeTab === 'threshold-whitelist' && (
          <ThresholdWhitelistTab
            selectedRepo={selectedRepo}
            installStatus={installStatus}
            configForm={configForm}
            onConfigFormChange={setConfigForm}
            summary={summary}
            whitelistInput={whitelistInput}
            onWhitelistInputChange={setWhitelistInput}
            onSaveConfig={handleSaveConfig}
            onSaveWhitelist={handleSaveWhitelist}
            isBusy={isBusy}
            isAuthed={Boolean(state.me)}
            loadingConfig={loadingConfig}
          />
        )}
        {activeTab === 'github-bot' && (
          <GitHubBotTab
            botClients={botClients}
            selectedBotClientId={selectedBotClientId}
            onSelectBotClient={handleSelectBotClient}
            newBotClientName={newBotClientName}
            onNewBotClientNameChange={setNewBotClientName}
            onCreateBotClient={handleCreateBotClient}
            onCreateBotKey={handleCreateBotKey}
            createdKeySecret={createdKeySecret}
            revokeKeyId={revokeKeyId}
            onRevokeKeyIdChange={setRevokeKeyId}
            onRevokeBotKey={handleRevokeBotKey}
            bindingsInput={bindingsInput}
            onBindingsInputChange={setBindingsInput}
            onSaveBindings={handleSaveBindings}
            isBusy={isBusy}
            isAuthed={Boolean(state.me)}
          />
        )}
      </main>
    </div>
  );
}
