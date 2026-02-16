export type PrAction = "opened" | "reopened" | "synchronize";

export type NormalizedPrEvent = {
  delivery_id: string;
  installation_id: number;
  action: PrAction;
  repository: {
    id: number;
    full_name: string;
  };
  pull_request: {
    number: number;
    id: number;
    html_url: string;
    user: {
      id: number;
      login: string;
    };
    head_sha: string;
    is_draft: boolean;
  };
  event_time: string;
};

export type InstallationAccountType = "User" | "Organization";

export type InstallationEventName = "installation" | "installation_repositories";

export type InstallationAction = "created" | "deleted" | "suspend" | "unsuspend";

export type InstallationRepositoriesAction = "added" | "removed";

export type InstallationSyncAction = InstallationAction | InstallationRepositoriesAction;

export type InstallationRepositoryRef = {
  id: number;
  full_name: string;
};

export type NormalizedInstallationSyncEvent = {
  delivery_id: string;
  event_time: string;
  event_name: InstallationEventName;
  action: InstallationSyncAction;
  installation: {
    id: number;
    account_login: string;
    account_type: InstallationAccountType;
  };
  repositories_added: InstallationRepositoryRef[];
  repositories_removed: InstallationRepositoryRef[];
  repositories: InstallationRepositoryRef[];
};

export type IngestStatus = "ACCEPTED" | "DUPLICATE" | "IGNORED";

export type PullRequestIngestResponse = {
  ingest_status: IngestStatus;
  challenge_id: string | null;
  enqueued_actions: number;
};

export type InstallationSyncIngestResponse = {
  ingest_status: IngestStatus;
  updated_installation_id: number;
  updated_repositories: number;
};

export type BotActionType = "UPSERT_PR_COMMENT" | "CLOSE_PR_WITH_COMMENT";

export type BotActionPayload = {
  comment_markdown: string;
  comment_marker: string;
  reason?: string;
};

export type BotAction = {
  id: string;
  action_type: BotActionType;
  installation_id: number;
  github_repo_id: number;
  repo_full_name: string;
  github_pr_number: number;
  challenge_id: string | null;
  payload: BotActionPayload;
  attempts: number;
  created_at: string;
};

export type BotActionsClaimResponse = {
  actions: BotAction[];
};

export type BotActionOutcome = "SUCCEEDED" | "RETRYABLE_FAILURE" | "FAILED";

export type BotActionResultStatus = "DONE" | "PENDING" | "FAILED";

export type BotActionResultResponse = {
  id: string;
  status: BotActionResultStatus;
};
