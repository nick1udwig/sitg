export type InputMode = 'ETH' | 'USD';

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface MeResponse {
  github_user_id: number;
  github_login: string;
  linked_wallet: string | null;
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
  spot_quote_id: string;
  message: string;
}

export interface RepoConfigResponse {
  github_repo_id: number;
  threshold: RepoThreshold;
  draft_prs_gated: boolean;
}

export interface WhitelistEntry {
  github_user_id: number;
  github_login: string;
}

export interface GateViewResponse {
  challenge_id: string;
  status: 'PENDING' | 'VERIFIED' | 'EXPIRED';
  deadline_at: string;
  is_whitelisted: boolean;
  challenge_login: string;
  repo_full_name: string;
  pull_request_number: number;
  pull_request_url: string;
  head_sha: string;
  linked_wallet: string | null;
  has_sufficient_stake: boolean;
  lock_active: boolean;
}

export interface ConfirmTypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
}
