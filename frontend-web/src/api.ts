import type {
  ApiError,
  ApiErrorBody,
  BotClient,
  ConfirmResponse,
  ConfirmTypedDataResponse,
  CreateBotClientResponse,
  CreateBotKeyResponse,
  GateResponse,
  InstallStatusResponse,
  MeResponse,
  RepoConfigResponse,
  RepoOption,
  ResolveLoginsResponse,
  StakeStatusResponse,
  WalletLinkChallengeResponse,
  WalletLinkConfirmResponse,
  WalletLinkStatusResponse,
  WhitelistEntry
} from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

function normalizeErrorCode(rawCode: string | undefined, message: string): string | undefined {
  if (!rawCode) {
    return undefined;
  }

  if (rawCode !== 'CONFLICT') {
    return rawCode;
  }

  const conflictMatch = message.match(/conflict:\s*([A-Z_]+)/i);
  if (conflictMatch?.[1]) {
    return conflictMatch[1].toUpperCase();
  }

  return rawCode;
}

function makeApiError(message: string, status?: number, code?: string): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.code = normalizeErrorCode(code, message);
  return err;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw makeApiError(
      payload?.error.message ?? `Request failed (${response.status})`,
      response.status,
      payload?.error.code
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw makeApiError(
      'The API returned an unexpected response. Is the backend running?',
      response.status,
      'BAD_RESPONSE'
    );
  }
}

async function requestOptional<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    const apiError = error as ApiError;
    if (apiError.status === 404 || apiError.status === 501) {
      return null;
    }
    throw error;
  }
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>('/api/v1/me');
  } catch {
    return null;
  }
}

export async function githubSignIn(redirectAfter?: string): Promise<void> {
  const redirect = redirectAfter ? `?redirect_after=${encodeURIComponent(redirectAfter)}` : '';
  const url = `${API_BASE}/api/v1/auth/github/start${redirect}`;

  const res = await fetch(url, { credentials: 'include', redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    window.location.href = url;
    return;
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    throw makeApiError(
      'GitHub sign-in is not available. The API is not reachable — check your deployment.',
      res.status,
      'SIGN_IN_UNAVAILABLE'
    );
  }

  window.location.href = url;
}

export async function logout(): Promise<void> {
  await request('/api/v1/auth/logout', { method: 'POST' });
}

export function getRepoConfig(repoId: string): Promise<RepoConfigResponse> {
  return request<RepoConfigResponse>(`/api/v1/repos/${repoId}/config`);
}

export function putRepoConfig(
  repoId: string,
  payload: { input_mode: 'ETH' | 'USD'; input_value: string; draft_prs_gated: boolean }
): Promise<RepoConfigResponse> {
  return request<RepoConfigResponse>(`/api/v1/repos/${repoId}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
}

export function getOwnedRepos(): Promise<RepoOption[] | null> {
  return requestOptional<RepoOption[]>('/api/v1/repos');
}

export function getInstallStatus(repoId: string): Promise<InstallStatusResponse | null> {
  return requestOptional<InstallStatusResponse>(`/api/v1/github/installations/status?repo_id=${encodeURIComponent(repoId)}`);
}

export function listBotClients(): Promise<BotClient[] | null> {
  return requestOptional<BotClient[]>('/api/v1/bot-clients');
}

export function createBotClient(name: string): Promise<CreateBotClientResponse> {
  return request<CreateBotClientResponse>('/api/v1/bot-clients', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name })
  });
}

export function createBotClientKey(botClientId: string): Promise<CreateBotKeyResponse> {
  return request<CreateBotKeyResponse>(`/api/v1/bot-clients/${encodeURIComponent(botClientId)}/keys`, {
    method: 'POST',
    headers: JSON_HEADERS
  });
}

export function revokeBotClientKey(botClientId: string, keyId: string): Promise<void> {
  return request<void>(
    `/api/v1/bot-clients/${encodeURIComponent(botClientId)}/keys/${encodeURIComponent(keyId)}/revoke`,
    {
      method: 'POST',
      headers: JSON_HEADERS
    }
  );
}

export function setBotInstallationBindings(botClientId: string, installationIds: number[]): Promise<void> {
  return request<void>(`/api/v1/bot-clients/${encodeURIComponent(botClientId)}/installation-bindings`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ installation_ids: installationIds })
  });
}

export function resolveWhitelistLogins(repoId: string, logins: string[]): Promise<ResolveLoginsResponse> {
  return request<ResolveLoginsResponse>(`/api/v1/repos/${repoId}/whitelist/resolve-logins`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ logins })
  });
}

export function putWhitelist(repoId: string, entries: WhitelistEntry[]): Promise<void> {
  return request<void>(`/api/v1/repos/${repoId}/whitelist`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ entries })
  });
}

export function getGate(gateToken: string): Promise<GateResponse> {
  return request<GateResponse>(`/api/v1/gate/${gateToken}`);
}

export function getConfirmTypedData(gateToken: string): Promise<ConfirmTypedDataResponse> {
  return request<ConfirmTypedDataResponse>(`/api/v1/gate/${gateToken}/confirm-typed-data`);
}

export function submitGateConfirmation(gateToken: string, signature: string): Promise<ConfirmResponse> {
  return request<ConfirmResponse>(`/api/v1/gate/${gateToken}/confirm`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ signature })
  });
}

export function requestWalletLinkChallenge(): Promise<WalletLinkChallengeResponse> {
  return request<WalletLinkChallengeResponse>('/api/v1/wallet/link/challenge', {
    method: 'POST',
    headers: JSON_HEADERS
  });
}

export function confirmWalletLink(payload: {
  nonce: string;
  wallet_address: string;
  signature: string;
}): Promise<WalletLinkConfirmResponse> {
  return request<WalletLinkConfirmResponse>('/api/v1/wallet/link/confirm', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
}

export function getWalletLinkStatus(): Promise<WalletLinkStatusResponse | null> {
  return requestOptional<WalletLinkStatusResponse>('/api/v1/wallet/link');
}

export function getStakeStatus(walletAddress: string): Promise<StakeStatusResponse | null> {
  return requestOptional<StakeStatusResponse>(`/api/v1/stake/status?wallet=${encodeURIComponent(walletAddress)}`);
}

export function unlinkWallet(): Promise<void> {
  return request<void>('/api/v1/wallet/link', {
    method: 'DELETE'
  });
}
