import type {
  ApiError,
  ConfirmTypedData,
  GateViewResponse,
  MeResponse,
  RepoConfigResponse,
  WhitelistEntry
} from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init
  });

  if (!response.ok) {
    const maybeError = (await response.json().catch(() => null)) as ApiError | null;
    const message = maybeError?.error?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>('/api/v1/me');
  } catch {
    return null;
  }
}

export function githubSignIn(): void {
  window.location.href = '/api/v1/auth/github/start';
}

export async function getRepoConfig(repoId: string): Promise<RepoConfigResponse> {
  return request<RepoConfigResponse>(`/api/v1/repos/${repoId}/config`);
}

export async function putRepoConfig(
  repoId: string,
  payload: { input_mode: 'ETH' | 'USD'; input_value: string; draft_prs_gated: boolean }
): Promise<RepoConfigResponse> {
  return request<RepoConfigResponse>(`/api/v1/repos/${repoId}/config`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
}

export async function resolveWhitelistLogins(repoId: string, logins: string[]) {
  return request<{ resolved: WhitelistEntry[]; unresolved: string[] }>(
    `/api/v1/repos/${repoId}/whitelist/resolve-logins`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ logins })
    }
  );
}

export async function putWhitelist(repoId: string, entries: WhitelistEntry[]): Promise<void> {
  await request(`/api/v1/repos/${repoId}/whitelist`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ entries })
  });
}

export async function getGate(gateToken: string): Promise<GateViewResponse> {
  return request<GateViewResponse>(`/api/v1/gate/${gateToken}`);
}

export async function requestWalletLinkChallenge() {
  return request<{ challenge: string }>('/api/v1/wallet/link/challenge', {
    method: 'POST',
    headers: JSON_HEADERS
  });
}

export async function confirmWalletLink(signature: string): Promise<void> {
  await request('/api/v1/wallet/link/confirm', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ signature })
  });
}

export async function unlinkWallet(): Promise<void> {
  await request('/api/v1/wallet/link', {
    method: 'DELETE'
  });
}

export async function getConfirmTypedData(gateToken: string): Promise<ConfirmTypedData> {
  return request<ConfirmTypedData>(`/api/v1/gate/${gateToken}/confirm-typed-data`);
}

export async function submitGateConfirmation(gateToken: string, signature: string): Promise<'VERIFIED'> {
  const data = await request<{ status: 'VERIFIED' }>(`/api/v1/gate/${gateToken}/confirm`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ signature })
  });

  return data.status;
}
