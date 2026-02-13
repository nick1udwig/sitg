const must = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export type AppConfig = {
  port: number;
  githubWebhookSecret: string;
  githubApiBaseUrl: string;
  backendBaseUrl: string;
  backendServiceToken?: string;
  backendBotKeyId: string;
  backendInternalHmacSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  deadlineInternalToken?: string;
  exemptCommentEnabled: boolean;
  stateFilePath: string;
  workerId: string;
  outboxPollingEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxClaimLimit: number;
  enableLocalDeadlineTimers: boolean;
  defaultInstallationId?: number;
};

export const readConfig = (): AppConfig => {
  const portRaw = process.env.PORT ?? "3000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
  }

  const outboxPollIntervalRaw = process.env.OUTBOX_POLL_INTERVAL_MS ?? "5000";
  const outboxPollIntervalMs = Number.parseInt(outboxPollIntervalRaw, 10);
  if (!Number.isFinite(outboxPollIntervalMs) || outboxPollIntervalMs < 500) {
    throw new Error(`Invalid OUTBOX_POLL_INTERVAL_MS value: ${outboxPollIntervalRaw}`);
  }

  const outboxClaimLimitRaw = process.env.OUTBOX_CLAIM_LIMIT ?? "25";
  const outboxClaimLimit = Number.parseInt(outboxClaimLimitRaw, 10);
  if (!Number.isFinite(outboxClaimLimit) || outboxClaimLimit <= 0 || outboxClaimLimit > 100) {
    throw new Error(`Invalid OUTBOX_CLAIM_LIMIT value: ${outboxClaimLimitRaw}`);
  }

  const defaultInstallationIdRaw = process.env.DEFAULT_INSTALLATION_ID;
  const defaultInstallationId = defaultInstallationIdRaw ? Number.parseInt(defaultInstallationIdRaw, 10) : undefined;
  if (
    defaultInstallationIdRaw &&
    (defaultInstallationId === undefined || !Number.isFinite(defaultInstallationId) || defaultInstallationId <= 0)
  ) {
    throw new Error(`Invalid DEFAULT_INSTALLATION_ID value: ${defaultInstallationIdRaw}`);
  }

  return {
    port,
    githubWebhookSecret: must(process.env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"),
    githubApiBaseUrl: (process.env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    backendBaseUrl: must(process.env.BACKEND_BASE_URL, "BACKEND_BASE_URL").replace(/\/+$/, ""),
    backendServiceToken: process.env.BACKEND_SERVICE_TOKEN,
    backendBotKeyId: must(process.env.BACKEND_BOT_KEY_ID, "BACKEND_BOT_KEY_ID"),
    backendInternalHmacSecret: must(
      process.env.BACKEND_INTERNAL_HMAC_SECRET ?? process.env.BACKEND_SERVICE_TOKEN,
      "BACKEND_INTERNAL_HMAC_SECRET",
    ),
    githubAppId: must(process.env.GITHUB_APP_ID, "GITHUB_APP_ID"),
    githubAppPrivateKey: must(process.env.GITHUB_APP_PRIVATE_KEY, "GITHUB_APP_PRIVATE_KEY").replace(
      /\\n/g,
      "\n",
    ),
    deadlineInternalToken: process.env.DEADLINE_INTERNAL_TOKEN,
    exemptCommentEnabled: process.env.EXEMPT_COMMENT_ENABLED === "true",
    stateFilePath: process.env.BOT_STATE_FILE ?? "./data/bot-state.json",
    workerId: process.env.WORKER_ID ?? `bot-worker-${process.pid}`,
    outboxPollingEnabled: process.env.OUTBOX_POLLING_ENABLED !== "false",
    outboxPollIntervalMs,
    outboxClaimLimit,
    enableLocalDeadlineTimers: process.env.ENABLE_LOCAL_DEADLINE_TIMERS === "true",
    defaultInstallationId,
  };
};
