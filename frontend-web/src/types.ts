export type InputMode = 'ETH' | 'USD';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

export interface MeResponse {
  id: string;
  github_user_id: number;
  github_login: string;
}

export interface RepoThreshold {
  wei: string;
  eth: string;
  usd_estimate: string;
  input_mode: InputMode;
  input_value: string;
  spot_price_usd: string;
  spot_source: string;
  spot_at: string;
  spot_from_cache: boolean;
  spot_quote_id: string | null;
  message: string;
}

export interface RepoConfigResponse {
  github_repo_id: number;
  threshold: RepoThreshold;
  draft_prs_gated: boolean;
}

export interface RepoOption {
  id: number;
  full_name: string;
  installed?: boolean;
}

export interface InstallStatusResponse {
  installed: boolean;
  installation_id?: number;
}

export interface WalletLinkStatusResponse {
  wallet_address: string;
  chain_id: number;
  linked_at: string;
}

export interface StakeStatusResponse {
  staked_balance_wei: string;
  unlock_time: string;
  lock_active: boolean;
}

export interface BotClientKey {
  key_id: string;
  created_at?: string;
  revoked_at?: string | null;
  is_active?: boolean;
}

export interface BotClient {
  id: string;
  name: string;
  is_active?: boolean;
  created_at?: string;
  installation_ids?: number[];
  keys?: BotClientKey[];
}

export interface CreateBotClientResponse {
  id: string;
  name: string;
  is_active?: boolean;
  created_at?: string;
}

export interface CreateBotKeyResponse {
  key_id: string;
  secret: string;
  created_at: string;
}

export interface WhitelistEntry {
  github_user_id: number;
  github_login: string;
}

export interface ResolveLoginsResponse {
  resolved: WhitelistEntry[];
  unresolved: string[];
}

export interface GateResponse {
  challenge_id: string;
  status: 'PENDING' | 'VERIFIED' | 'EXEMPT' | 'TIMED_OUT_CLOSED' | string;
  github_repo_id: number;
  github_repo_full_name: string;
  github_pr_number: number;
  github_pr_author_id: number;
  github_pr_author_login: string;
  head_sha: string;
  deadline_at: string;
  threshold_wei_snapshot: string;
}

export interface ConfirmTypedDataResponse {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  primary_type?: string;
  primaryType?: string;
  types?: Record<string, Array<{ name: string; type: string }>>;
  message: {
    githubUserId: number;
    githubRepoId: number;
    pullRequestNumber: number;
    headSha: string;
    challengeId: string;
    nonce: string;
    expiresAt: number;
  };
}

export interface ConfirmResponse {
  status: 'VERIFIED';
}

export interface WalletLinkChallengeResponse {
  nonce: string;
  expires_at: string;
  message: string;
}

export interface WalletLinkConfirmResponse {
  wallet_address: string;
  linked: boolean;
}
