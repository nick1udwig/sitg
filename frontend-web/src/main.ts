import './styles.css';
import {
  confirmWalletLink,
  getConfirmTypedData,
  getGate,
  getMe,
  getRepoConfig,
  githubSignIn,
  putRepoConfig,
  putWhitelist,
  requestWalletLinkChallenge,
  resolveWhitelistLogins,
  submitGateConfirmation,
  unlinkWallet
} from './api';
import { formatCountdown, gateFailureMessage, parseGateToken } from './gate-logic';
import {
  addErrorNotice,
  addInfoNotice,
  clearNotices,
  dismissNotice,
  getState,
  isBusy,
  setMe,
  withBusyAction
} from './state';
import { signMessageWithInjectedWallet, signTypedDataWithInjectedWallet } from './wallet';
import type { GateViewResponse, RepoConfigResponse } from './types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app root element');
}
const appRoot = app;

let timerId: number | null = null;

function pathName(): string {
  return window.location.pathname;
}

function isDesktopSupported(): boolean {
  return window.matchMedia('(min-width: 900px)').matches;
}

function setContent(content: string): void {
  appRoot.innerHTML = content;
}

function noticesMarkup(): string {
  const notices = getState().notices;
  if (!notices.length) {
    return '';
  }

  return `
    <section class="grid" id="notice-stack">
      ${notices
        .map(
          (notice, index) => `
            <article class="card notice-toast notice-${notice.kind}">
              <div>
                <p class="meta">${notice.kind.toUpperCase()}</p>
                <p>${notice.message}</p>
              </div>
              <button class="ghost" data-dismiss-notice="${index}">Dismiss</button>
            </article>
          `
        )
        .join('')}
    </section>
  `;
}

function shell(content: string): string {
  const path = pathName();
  return `
    <header class="topbar">
      <div class="brand">Stake-to-Contribute</div>
      <nav class="nav">
        <a class="${path === '/' ? 'active' : ''}" href="/">Owner Setup</a>
        <a class="${path.startsWith('/wallet') ? 'active' : ''}" href="/wallet">Wallet</a>
      </nav>
    </header>
    ${noticesMarkup()}
    ${content}
  `;
}

function withDesktopGuard(content: string): string {
  if (isDesktopSupported()) {
    return shell(content);
  }

  return `
    <section class="card desktop-block">
      <h2>Desktop Only</h2>
      <p class="meta">Stake-to-Contribute MVP supports desktop web only.</p>
      <p>Open this page on a desktop browser to continue with repository setup or PR stake verification.</p>
    </section>
  `;
}

function bindSharedControls(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(anchor.getAttribute('href') || '/');
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-dismiss-notice]').forEach((button) => {
    button.addEventListener('click', () => {
      const indexValue = button.getAttribute('data-dismiss-notice');
      if (!indexValue) {
        return;
      }

      dismissNotice(Number(indexValue));
      void render();
    });
  });
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  void render();
}

window.addEventListener('popstate', () => {
  void render();
});

window.addEventListener('error', (event) => {
  addErrorNotice(event.error instanceof Error ? event.error.message : 'Unexpected runtime error.');
  void render();
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  addErrorNotice(reason instanceof Error ? reason.message : 'Unhandled async error.');
  void render();
});

async function refreshMe(): Promise<void> {
  setMe(await getMe());
}

function renderPage(content: string): void {
  setContent(withDesktopGuard(content));
  bindSharedControls();
}

async function renderOwnerSetup(): Promise<void> {
  const repoId = '1';
  let config: RepoConfigResponse | null = null;

  try {
    config = await getRepoConfig(repoId);
  } catch (error) {
    addErrorNotice(error instanceof Error ? error.message : 'Failed to load repo config');
  }

  const inputMode = config?.threshold.input_mode ?? 'ETH';
  const inputValue = config?.threshold.input_value ?? '0.10';
  const draftPrsGated = config?.draft_prs_gated ?? true;
  const enforcedEth = config?.threshold.eth ?? '0.10';
  const usdEstimate = config?.threshold.usd_estimate ?? '0.00';

  renderPage(`
    <section class="grid two">
      <article class="card">
        <h2>Repository Setup</h2>
        <p class="meta">Configure threshold and draft PR gating for this repository.</p>
        <div class="notice">
          <p><strong>Enforcement is in ETH.</strong></p>
          <p>USD value is an estimate using spot price at configuration time.</p>
        </div>
        <form id="repo-config-form">
          <label>
            Repo ID
            <input type="text" name="repo_id" value="${repoId}" disabled />
          </label>
          <label>
            Input mode
            <select name="input_mode">
              <option value="ETH" ${inputMode === 'ETH' ? 'selected' : ''}>ETH</option>
              <option value="USD" ${inputMode === 'USD' ? 'selected' : ''}>USD</option>
            </select>
          </label>
          <label>
            Input value
            <input name="input_value" value="${inputValue}" required />
          </label>
          <label>
            <span>Draft PRs gated</span>
            <select name="draft_prs_gated">
              <option value="true" ${draftPrsGated ? 'selected' : ''}>On (default)</option>
              <option value="false" ${!draftPrsGated ? 'selected' : ''}>Off</option>
            </select>
          </label>
          <button type="submit" ${isBusy('save-config') ? 'disabled' : ''}>${isBusy('save-config') ? 'Saving...' : 'Save config'}</button>
        </form>
      </article>

      <article class="card">
        <h3>Current enforcement snapshot</h3>
        <dl class="kv">
          <dt>Enforced ETH</dt><dd>${enforcedEth}</dd>
          <dt>USD estimate</dt><dd>${usdEstimate}</dd>
          <dt>Input mode</dt><dd>${inputMode}</dd>
          <dt>Draft PRs</dt><dd>${draftPrsGated ? 'Gated' : 'Not gated'}</dd>
        </dl>

        <h3>Whitelist management</h3>
        <p class="meta">Enter GitHub logins, resolve to user IDs, and save.</p>
        <form id="whitelist-form">
          <label>
            GitHub logins (comma separated)
            <textarea name="logins" placeholder="alice, bob"></textarea>
          </label>
          <button type="submit" ${isBusy('save-whitelist') ? 'disabled' : ''}>${isBusy('save-whitelist') ? 'Saving...' : 'Resolve and save whitelist'}</button>
        </form>
      </article>
    </section>
  `);

  const repoConfigForm = document.querySelector<HTMLFormElement>('#repo-config-form');
  repoConfigForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(repoConfigForm);
    const input_mode = String(formData.get('input_mode')) as 'ETH' | 'USD';
    const input_value = String(formData.get('input_value') || '');
    const draft_prs_gated = String(formData.get('draft_prs_gated')) === 'true';

    const result = await withBusyAction(
      'save-config',
      () => putRepoConfig(repoId, { input_mode, input_value, draft_prs_gated }),
      { successMessage: 'Repository configuration saved.' }
    );

    if (result) {
      await renderOwnerSetup();
      return;
    }

    void render();
  });

  const whitelistForm = document.querySelector<HTMLFormElement>('#whitelist-form');
  whitelistForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(whitelistForm);
    const loginField = String(formData.get('logins') || '');
    const logins = loginField
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    if (!logins.length) {
      addInfoNotice('Provide at least one GitHub login before saving whitelist.');
      void render();
      return;
    }

    const resolved = await withBusyAction('save-whitelist', () => resolveWhitelistLogins(repoId, logins));
    if (!resolved) {
      void render();
      return;
    }

    const saved = await withBusyAction(
      'save-whitelist',
      async () => {
        await putWhitelist(repoId, resolved.resolved);
        return resolved;
      },
      {
        successMessage: `Saved ${resolved.resolved.length} whitelist login(s). Unresolved: ${
          resolved.unresolved.join(', ') || 'none'
        }.`
      }
    );

    if (saved) {
      await renderOwnerSetup();
      return;
    }

    void render();
  });
}

function gateStatusBadge(gate: GateViewResponse): string {
  if (gate.status === 'VERIFIED') {
    return '<span class="badge ok">Verified</span>';
  }

  if (gate.status === 'EXPIRED') {
    return '<span class="badge warn">Expired</span>';
  }

  return '<span class="badge">Pending</span>';
}

function gateFailureState(gate: GateViewResponse): string {
  const message = gateFailureMessage(gate, getState().me);
  if (message) {
    return `<p class="${
      gate.status === 'EXPIRED' ||
      message.includes('Wrong') ||
      message.includes('No linked') ||
      message.includes('Insufficient')
        ? 'error'
        : 'meta'
    }">${message}</p>`;
  }

  return '<p class="success">Ready to sign PR confirmation.</p>';
}

async function renderGatePage(gateToken: string): Promise<void> {
  let gate: GateViewResponse | null = null;

  try {
    gate = await getGate(gateToken);
  } catch (e) {
    addErrorNotice(e instanceof Error ? e.message : 'Failed to load gate');
  }

  if (!gate) {
    renderPage(`
      <section class="card">
        <h2>Contributor Gate</h2>
        <p class="error">Gate unavailable.</p>
      </section>
    `);
    return;
  }

  const me = getState().me;

  renderPage(`
    <section class="grid two">
      <article class="card">
        <h2>PR Stake Gate ${gateStatusBadge(gate)}</h2>
        <p class="meta">${gate.repo_full_name} · PR #${gate.pull_request_number}</p>
        <p class="countdown" id="countdown">${formatCountdown(gate.deadline_at)}</p>
        <p><a href="${gate.pull_request_url}" target="_blank" rel="noreferrer">Open PR</a></p>
        <dl class="kv">
          <dt>Challenge login</dt><dd>${gate.challenge_login}</dd>
          <dt>Head SHA</dt><dd>${gate.head_sha.slice(0, 12)}...</dd>
          <dt>Linked wallet</dt><dd>${gate.linked_wallet ?? 'none'}</dd>
          <dt>Whitelist</dt><dd>${gate.is_whitelisted ? 'Exempt' : 'Not exempt'}</dd>
        </dl>
      </article>

      <article class="card">
        <h3>Verification Actions</h3>
        ${gateFailureState(gate)}
        <div class="grid">
          ${!me ? `<button id="signin-btn">Sign in with GitHub</button>` : ''}
          ${me && !gate.linked_wallet ? `<button id="link-wallet-btn" ${isBusy('link-wallet') ? 'disabled' : ''}>${isBusy('link-wallet') ? 'Connecting...' : 'Connect wallet'}</button>` : ''}
          ${
            me && gate.linked_wallet && (!gate.has_sufficient_stake || !gate.lock_active)
              ? '<button id="fund-stake-btn" class="ghost">Fund + Stake</button>'
              : ''
          }
          ${
            me &&
            gate.linked_wallet &&
            gate.has_sufficient_stake &&
            gate.lock_active &&
            gate.status !== 'VERIFIED'
              ? `<button id="confirm-btn" ${isBusy('confirm-pr') ? 'disabled' : ''}>${isBusy('confirm-pr') ? 'Awaiting signature...' : 'Sign PR confirmation'}</button>`
              : ''
          }
          ${gate.status === 'VERIFIED' ? '<p class="success">PR verified.</p>' : ''}
        </div>
      </article>
    </section>
  `);

  if (timerId) {
    window.clearInterval(timerId);
  }
  const countdownNode = document.querySelector<HTMLElement>('#countdown');
  timerId = window.setInterval(() => {
    if (!countdownNode) {
      return;
    }
    countdownNode.textContent = formatCountdown(gate.deadline_at);
  }, 1000);

  const signInBtn = document.querySelector<HTMLButtonElement>('#signin-btn');
  signInBtn?.addEventListener('click', () => {
    githubSignIn();
  });

  const linkWalletBtn = document.querySelector<HTMLButtonElement>('#link-wallet-btn');
  linkWalletBtn?.addEventListener('click', async () => {
    const linked = await withBusyAction(
      'link-wallet',
      async () => {
        const challenge = await requestWalletLinkChallenge();
        const signature = await signMessageWithInjectedWallet(challenge.challenge);
        await confirmWalletLink(signature);
      },
      { successMessage: 'Wallet linked successfully.' }
    );

    if (linked !== null) {
      await refreshMe();
      await renderGatePage(gateToken);
      return;
    }

    void render();
  });

  const fundStakeBtn = document.querySelector<HTMLButtonElement>('#fund-stake-btn');
  fundStakeBtn?.addEventListener('click', () => {
    addInfoNotice('Stake is insufficient or lock is inactive. Fund and lock ETH in the staking contract, then reload.');
    void render();
  });

  const confirmBtn = document.querySelector<HTMLButtonElement>('#confirm-btn');
  confirmBtn?.addEventListener('click', async () => {
    const result = await withBusyAction(
      'confirm-pr',
      async () => {
        const typedData = await getConfirmTypedData(gateToken);
        const signature = await signTypedDataWithInjectedWallet(typedData, gate.linked_wallet ?? undefined);
        return submitGateConfirmation(gateToken, signature);
      },
      { successMessage: 'PR verified.' }
    );

    if (result === 'VERIFIED') {
      await renderGatePage(gateToken);
      return;
    }

    void render();
  });
}

async function renderWalletPage(): Promise<void> {
  const me = getState().me;
  const wallet = me?.linked_wallet;

  renderPage(`
    <section class="card">
      <h2>Wallet Link Management</h2>
      <p class="meta">One active wallet per GitHub account and one active GitHub account per wallet.</p>
      ${!me ? '<p class="error">Sign in with GitHub first.</p><button id="wallet-signin">Sign in with GitHub</button>' : ''}
      ${
        me
          ? `<dl class="kv"><dt>GitHub login</dt><dd>${me.github_login}</dd><dt>Linked wallet</dt><dd>${
              wallet ?? 'none'
            }</dd></dl>`
          : ''
      }
      ${
        me && !wallet
          ? `<button id="wallet-connect" ${isBusy('link-wallet') ? 'disabled' : ''}>${isBusy('link-wallet') ? 'Connecting...' : 'Connect wallet'}</button>`
          : ''
      }
      ${
        me && wallet
          ? `<p class="meta">Unlink is blocked if this wallet has non-zero staked balance.</p><button id="unlink-wallet" class="warn" ${
              isBusy('unlink-wallet') ? 'disabled' : ''
            }>${isBusy('unlink-wallet') ? 'Unlinking...' : 'Unlink wallet'}</button>`
          : ''
      }
    </section>
  `);

  const walletSignin = document.querySelector<HTMLButtonElement>('#wallet-signin');
  walletSignin?.addEventListener('click', () => githubSignIn());

  const connectBtn = document.querySelector<HTMLButtonElement>('#wallet-connect');
  connectBtn?.addEventListener('click', async () => {
    const linked = await withBusyAction(
      'link-wallet',
      async () => {
        const challenge = await requestWalletLinkChallenge();
        const signature = await signMessageWithInjectedWallet(challenge.challenge);
        await confirmWalletLink(signature);
      },
      { successMessage: 'Wallet linked successfully.' }
    );

    if (linked !== null) {
      await refreshMe();
      await renderWalletPage();
      return;
    }

    void render();
  });

  const unlinkBtn = document.querySelector<HTMLButtonElement>('#unlink-wallet');
  unlinkBtn?.addEventListener('click', async () => {
    const unlinked = await withBusyAction(
      'unlink-wallet',
      async () => {
        await unlinkWallet();
      },
      { successMessage: 'Wallet unlinked.' }
    );

    if (unlinked !== null) {
      await refreshMe();
      await renderWalletPage();
      return;
    }

    void render();
  });
}

function renderFatalBoundary(message: string): void {
  renderPage(`
    <section class="card">
      <h2>Something went wrong</h2>
      <p class="error">${message}</p>
      <button id="retry-render">Retry</button>
    </section>
  `);

  const retry = document.querySelector<HTMLButtonElement>('#retry-render');
  retry?.addEventListener('click', () => {
    clearNotices();
    void render();
  });
}

async function render(): Promise<void> {
  try {
    await refreshMe();
    const currentPath = pathName();

    if (currentPath === '/') {
      await renderOwnerSetup();
      return;
    }

    if (currentPath === '/wallet') {
      await renderWalletPage();
      return;
    }

    const gateToken = parseGateToken(currentPath);
    if (gateToken) {
      await renderGatePage(gateToken);
      return;
    }

    renderPage(`
      <section class="card">
        <h2>Page not found</h2>
        <p><a href="/">Return to owner setup</a></p>
      </section>
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected render failure.';
    addErrorNotice(message);
    renderFatalBoundary(message);
  }
}

void render();
