const must = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export type AppConfig = {
  port: number;
  githubWebhookSecret: string;
  backendBaseUrl: string;
  backendServiceToken?: string;
  backendInternalHmacSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  deadlineInternalToken?: string;
  exemptCommentEnabled: boolean;
  stateFilePath: string;
};

export const readConfig = (): AppConfig => {
  const portRaw = process.env.PORT ?? "3000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
  }

  return {
    port,
    githubWebhookSecret: must(process.env.GITHUB_WEBHOOK_SECRET, "GITHUB_WEBHOOK_SECRET"),
    backendBaseUrl: must(process.env.BACKEND_BASE_URL, "BACKEND_BASE_URL").replace(/\/+$/, ""),
    backendServiceToken: process.env.BACKEND_SERVICE_TOKEN,
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
  };
};
