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

export type BackendDecision = "IGNORE" | "EXEMPT" | "ALREADY_VERIFIED" | "REQUIRE_STAKE";

export type PrEventDecisionResponse = {
  decision: BackendDecision;
  challenge?: {
    id: string;
    gate_url: string;
    deadline_at: string;
    comment_markdown: string;
  };
};

export type DeadlineCheckResponse = {
  action?: string;
  close?: {
    github_repo_id: number;
    github_pr_number: number;
    comment_markdown: string;
  } | null;
};

export type ScheduledDeadline = {
  challengeId: string;
  installationId: number;
  repoFullName: string;
  prNumber: number;
  deadlineAt: string;
};
