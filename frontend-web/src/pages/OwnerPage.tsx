import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../types';
import {
  getInstallStatus,
  getOwnedRepos,
  getRepoConfig,
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
import type { InputMode, InstallStatusResponse, RepoConfigResponse, RepoOption } from '../types';

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
  const { state, setMe, setRepo, runBusy, isBusy, pushNotice } = useAppState();
  const [config, setConfig] = useState<RepoConfigResponse | null>(null);
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [installStatus, setInstallStatus] = useState<InstallStatusResponse | null>(null);
  const [configForm, setConfigForm] = useState<RepoConfigFormState>(DEFAULT_FORM);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);
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
        if (repos) {
          setRepoOptions(repos);
          if (repos.length) {
            const selectedId = state.selectedRepo?.id ?? '';
            const selectedIsOwned = repos.some((repo) => String(repo.id) === selectedId);
            if (!selectedIsOwned) {
              const first = repos[0];
              setRepo({ id: String(first.id), fullName: first.full_name });
              if (selectedId) {
                pushNotice('info', 'Switched to an owned repository because the previous selection is no longer available.');
              }
            }
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
  }, [state.me, state.selectedRepo?.id, setMe, setRepo, pushNotice]);

  useEffect(() => {
    if (!selectedOwnedRepo || !state.me) {
      setConfig(null);
      setInstallStatus(null);
      return;
    }

    let mounted = true;
    setLoadingConfig(true);

    void Promise.all([getRepoConfig(selectedOwnedRepo.id).catch(() => null), getInstallStatus(selectedOwnedRepo.id).catch(() => null)])
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
        }

        setInstallStatus(install);
      })
      .catch((error) => {
        if (mounted) pushNotice('error', toUserMessage(error));
      })
      .finally(() => {
        if (mounted) setLoadingConfig(false);
      });

    return () => { mounted = false; };
  }, [selectedOwnedRepo, state.me, pushNotice]);

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

    const saved = await runBusy('save-whitelist', async () => {
      await putWhitelist(selectedOwnedRepo.id, resolved.resolved);
      return true;
    });

    if (!saved) { pushNotice('error', 'Whitelist save failed.'); return; }
    setWhitelistInput('');
    pushNotice('success', `Saved ${resolved.resolved.length} whitelist entries. Unresolved: ${resolved.unresolved.join(', ') || 'none'}.`);
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
  const installStatusView = installStatus
    ? (installStatus.installed ? 'installed' : 'not-installed')
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
      <div className="auth-prompt">
        <div className="landing-brand">Skin In The Game</div>
        <p className="auth-prompt-desc">
          Sign in with GitHub to configure repositories, set stake thresholds, and connect the GitHub App.
        </p>
        <button
          disabled={isBusy('github-sign-in') || signInStarting}
          onClick={() => void handleGitHubSignIn()}
          aria-label="Sign in with GitHub"
        >
          {isBusy('github-sign-in') || signInStarting ? 'Opening GitHub...' : 'Sign in with GitHub'}
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
        isBusy={isBusy}
      />
      <main>
        <OwnerTabs active={activeTab} onSelect={setActiveTab} />
        {activeTab === 'repo-info' && (
          <RepoInfoTab
            selectedRepo={selectedRepo}
            installStatus={installStatusView}
            installDetails={installStatus}
            installUrl={installUrl}
          />
        )}
        {activeTab === 'threshold-whitelist' && (
          <ThresholdWhitelistTab
            selectedRepo={selectedRepo}
            installStatus={installStatusView}
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
      </main>
    </div>
  );
}
