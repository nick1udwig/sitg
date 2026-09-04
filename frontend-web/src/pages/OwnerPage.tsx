import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../types';
import {
  deleteWhitelistEntry,
  getInstallStatus,
  getOwnedRepos,
  getRepoConfig,
  getWhitelist,
  githubSignIn,
  putRepoConfig,
  putWhitelist,
  resolveWhitelistLogins
} from '../api';
import { toUserMessage } from '../lib/error-map';
import { useAppState } from '../state';
import type { RepoSelection } from '../state';
import { OwnerSidebar } from '../components/OwnerSidebar';
import { OwnerTabs } from '../components/OwnerTabs';
import type { OwnerTabId } from '../components/OwnerTabs';
import { RepoInfoTab } from './owner/RepoInfoTab';
import { ThresholdWhitelistTab } from './owner/ThresholdWhitelistTab';
import type { InputMode, InstallStatusResponse, RepoConfigResponse, RepoOption, WhitelistEntry } from '../types';

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

function OwnerAuthPrompt({ busy, onSignIn }: { busy: boolean; onSignIn: () => void }) {
  return (
    <div className="auth-prompt">
      <div className="landing-brand">Skin In The Game</div>
      <p className="auth-prompt-desc">
        Sign in with GitHub to configure repositories, set stake thresholds, and connect the GitHub App.
      </p>
      <button disabled={busy} onClick={onSignIn} aria-label="Sign in with GitHub">
        {busy ? 'Opening GitHub...' : 'Sign in with GitHub'}
      </button>
    </div>
  );
}

export function OwnerPage() {
  const { state, setMe, setRepo, runBusy, isBusy, pushNotice } = useAppState();
  const [config, setConfig] = useState<RepoConfigResponse | null>(null);
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [installStatus, setInstallStatus] = useState<InstallStatusResponse | null>(null);
  const [configForm, setConfigForm] = useState<RepoConfigFormState>(DEFAULT_FORM);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [whitelistEntries, setWhitelistEntries] = useState<WhitelistEntry[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadedRepoId, setLoadedRepoId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<OwnerTabId>('repo-info');
  const [signInStarting, setSignInStarting] = useState(false);

  const selectedRepo = state.selectedRepo;
  const selectedOwnedRepo = useMemo<RepoSelection | null>(() => {
    if (!selectedRepo) return null;
    const match = repoOptions.find((repo) => String(repo.id) === selectedRepo.id);
    if (!match) return null;
    return { id: String(match.id), fullName: match.full_name };
  }, [repoOptions, selectedRepo]);

  const isSessionExpiredError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const apiError = error as ApiError;
    if (apiError.code === 'UNAUTHENTICATED' || apiError.status === 401) {
      return true;
    }

    // Backward compatibility for older backend builds that returned 400 VALIDATION_ERROR.
    const message = (apiError.message ?? '').toLowerCase();
    return (
      apiError.code === 'VALIDATION_ERROR'
      && message.includes('github repository listing failed')
    );
  };

  useEffect(() => {
    if (!state.me) {
      setRepoOptions([]);
      return;
    }

    let mounted = true;
    void getOwnedRepos()
      .then((repos) => {
        if (!mounted) return;
        const availableRepos = repos ?? [];
        setRepoOptions(availableRepos);
        const selectedId = state.selectedRepo?.id ?? '';
        const selectedIsOwned = availableRepos.some((repo) => String(repo.id) === selectedId);
        if (!selectedIsOwned) {
          const first = availableRepos[0];
          setRepo(first ? { id: String(first.id), fullName: first.full_name } : null);
          if (selectedId) {
            pushNotice('info', first
              ? 'Switched to an owned repository because the previous selection is no longer available.'
              : 'The previous repository is no longer available.');
          }
        }
      })
      .catch((error) => {
        if (!mounted) return;
        if (isSessionExpiredError(error)) {
          setMe(null);
          pushNotice('info', 'Session expired, please sign in again.');
          return;
        }
        pushNotice('error', toUserMessage(error));
      });

    return () => { mounted = false; };
  }, [state.me, setMe, setRepo, pushNotice]);

  useEffect(() => {
    if (!selectedOwnedRepo || !state.me) {
      setConfig(null);
      setInstallStatus(null);
      setConfigForm(DEFAULT_FORM);
      setWhitelistInput('');
      setWhitelistEntries([]);
      setLoadedRepoId(null);
      setLoadingConfig(false);
      return;
    }

    let mounted = true;
    setConfig(null);
    setInstallStatus(null);
    setConfigForm(DEFAULT_FORM);
    setWhitelistInput('');
    setWhitelistEntries([]);
    setLoadedRepoId(null);
    setLoadingConfig(true);

    const optionalConfig = getRepoConfig(selectedOwnedRepo.id).catch((error: unknown) => {
      const apiError = error as ApiError;
      if (apiError.status === 404 || apiError.code === 'NOT_FOUND') return null;
      throw error;
    });

    void Promise.all([
      optionalConfig,
      getInstallStatus(selectedOwnedRepo.id),
      getWhitelist(selectedOwnedRepo.id)
    ])
      .then(([repoConfig, install, whitelist]) => {
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
        }

        setInstallStatus(install);
        setWhitelistEntries(whitelist ?? []);
        setLoadedRepoId(selectedOwnedRepo.id);
      })
      .catch((error) => {
        if (!mounted) return;
        setConfig(null);
        setInstallStatus(null);
        setConfigForm(DEFAULT_FORM);
        setWhitelistEntries([]);
        setLoadedRepoId(selectedOwnedRepo.id);
        if (isSessionExpiredError(error)) {
          setMe(null);
          pushNotice('info', 'Session expired, please sign in again.');
        } else {
          pushNotice('error', toUserMessage(error));
        }
      })
      .finally(() => {
        if (mounted) setLoadingConfig(false);
      });

    return () => { mounted = false; };
  }, [selectedOwnedRepo, state.me, setMe, pushNotice]);

  const detailsAreCurrent = Boolean(
    selectedOwnedRepo
    && loadedRepoId === selectedOwnedRepo.id
  );
  const displayedConfig = detailsAreCurrent ? config : null;
  const displayedInstallStatus = detailsAreCurrent ? installStatus : null;
  const displayedConfigForm = detailsAreCurrent ? configForm : DEFAULT_FORM;
  const displayedWhitelistEntries = detailsAreCurrent ? whitelistEntries : [];
  const detailsLoading = Boolean(selectedOwnedRepo && (!detailsAreCurrent || loadingConfig));

  const summary = useMemo(() => {
    if (!displayedConfig) {
      return {
        enforcedEth: displayedConfigForm.inputMode === 'ETH' ? displayedConfigForm.inputValue : 'pending',
        usdEstimate: 'pending'
      };
    }
    return { enforcedEth: displayedConfig.threshold.eth, usdEstimate: displayedConfig.threshold.usd_estimate };
  }, [displayedConfig, displayedConfigForm]);

  const handleSaveConfig = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedOwnedRepo) { pushNotice('error', 'Select one of your owned repositories first.'); return; }

    const result = await runBusy('save-config', async () =>
      putRepoConfig(selectedOwnedRepo.id, {
        input_mode: configForm.inputMode,
        input_value: configForm.inputValue,
        draft_prs_gated: configForm.draftPrsGated
      })
    );

    if (!result) { pushNotice('error', 'Saving config failed.'); return; }
    setConfig(result);
    pushNotice('success', `Saved config for ${selectedOwnedRepo.fullName}. Enforced ETH: ${result.threshold.eth}.`);
  };

  const handleSaveWhitelist = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedOwnedRepo) { pushNotice('error', 'Select one of your owned repositories first.'); return; }

    const logins = whitelistInput.split(',').map((v) => v.trim()).filter(Boolean);
    if (!logins.length) { pushNotice('info', 'Provide at least one GitHub login.'); return; }

    const resolved = await runBusy('save-whitelist', () => resolveWhitelistLogins(selectedOwnedRepo.id, logins));
    if (!resolved) { pushNotice('error', 'Whitelist login resolution failed.'); return; }

    if (!resolved.resolved.length) {
      setWhitelistInput(resolved.unresolved.join(', '));
      pushNotice('error', `No GitHub logins could be resolved: ${resolved.unresolved.join(', ')}.`);
      return;
    }

    const saved = await runBusy('save-whitelist', async () => {
      await putWhitelist(selectedOwnedRepo.id, resolved.resolved);
      return true;
    });

    if (!saved) { pushNotice('error', 'Whitelist save failed.'); return; }
    setWhitelistEntries((current) => {
      const byId = new Map(current.map((entry) => [entry.github_user_id, entry]));
      for (const entry of resolved.resolved) {
        byId.set(entry.github_user_id, entry);
      }
      return [...byId.values()].sort((a, b) => a.github_login.localeCompare(b.github_login));
    });
    setWhitelistInput(resolved.unresolved.join(', '));
    pushNotice('success', `Saved ${resolved.resolved.length} whitelist entries. Unresolved: ${resolved.unresolved.join(', ') || 'none'}.`);
  };

  const handleDeleteWhitelistEntry = async (entry: WhitelistEntry): Promise<void> => {
    if (!selectedOwnedRepo) return;
    const busyKey = `delete-whitelist-${entry.github_user_id}`;
    const deleted = await runBusy(busyKey, async () => {
      await deleteWhitelistEntry(selectedOwnedRepo.id, entry.github_user_id);
      return true;
    });
    if (!deleted) return;

    setWhitelistEntries((current) => current.filter(
      (candidate) => candidate.github_user_id !== entry.github_user_id
    ));
    pushNotice('success', `Removed @${entry.github_login} from the whitelist.`);
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

  const installUrl = import.meta.env.VITE_GITHUB_APP_INSTALL_URL ?? '';
  const installStatusView = displayedInstallStatus
    ? !displayedInstallStatus.installed
      ? 'not-installed'
      : displayedInstallStatus.repo_connected
        ? 'connected'
        : 'not-connected'
    : 'unknown';

  const handleGitHubSignIn = async (): Promise<void> => {
    if (isBusy('github-sign-in') || signInStarting) return;
    setSignInStarting(true);
    const started = await runBusy('github-sign-in', async () => {
      await githubSignIn(window.location.href);
      return true;
    });
    if (!started) {
      setSignInStarting(false);
    }
  };

  if (!state.me) {
    return (
      <OwnerAuthPrompt
        busy={isBusy('github-sign-in') || signInStarting}
        onSignIn={() => { void handleGitHubSignIn(); }}
      />
    );
  }

  return (
    <div className="owner-shell">
      <OwnerSidebar
        repoOptions={repoOptions}
        selectedRepo={selectedOwnedRepo}
        onSelectRepo={setRepo}
        onResolveRepoByFullName={handleResolveRepoByFullName}
        isBusy={isBusy}
      />
      <main>
        <OwnerTabs active={activeTab} onSelect={setActiveTab} />
        {activeTab === 'repo-info' && (
          <RepoInfoTab
            selectedRepo={selectedOwnedRepo}
            installStatus={installStatusView}
            installDetails={displayedInstallStatus}
            installUrl={installUrl}
          />
        )}
        {activeTab === 'threshold-whitelist' && (
          <ThresholdWhitelistTab
            selectedRepo={selectedOwnedRepo}
            installStatus={installStatusView}
            configForm={displayedConfigForm}
            onConfigFormChange={setConfigForm}
            summary={summary}
            whitelistInput={whitelistInput}
            whitelistEntries={displayedWhitelistEntries}
            onWhitelistInputChange={setWhitelistInput}
            onSaveConfig={handleSaveConfig}
            onSaveWhitelist={handleSaveWhitelist}
            onDeleteWhitelistEntry={handleDeleteWhitelistEntry}
            isBusy={isBusy}
            isAuthed={Boolean(state.me)}
            loadingConfig={detailsLoading}
          />
        )}
      </main>
    </div>
  );
}
