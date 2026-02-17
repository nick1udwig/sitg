import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { BackendClient } from "./backend.js";
import type { AppConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import type { BotAction, BotActionOutcome, NormalizedInstallationSyncEvent } from "./types.js";
import { parseGitHubWebhookEvent } from "./webhook.js";

type AppContext = {
  config: AppConfig;
  backend: BackendClient;
  github: GitHubClient;
  metrics: MetricsStore;
};

type MetricsStore = {
  webhookEventsTotal: number;
  webhookIgnoredTotal: number;
  webhookPullRequestForwardedTotal: number;
  webhookInstallationSyncForwardedTotal: number;
  webhookIngestAcceptedTotal: number;
  webhookIngestDuplicateTotal: number;
  webhookIngestIgnoredTotal: number;
  outboxClaimTotal: number;
  outboxActionsClaimedTotal: number;
  outboxActionsSuccessTotal: number;
  outboxActionsRetryableFailureTotal: number;
  outboxActionsFailedTotal: number;
  errorsTotal: number;
};

class BotActionExecutionError extends Error {
  readonly outcome: Exclude<BotActionOutcome, "SUCCEEDED">;
  readonly code: string;

  constructor(message: string, outcome: Exclude<BotActionOutcome, "SUCCEEDED">, code: string) {
    super(message);
    this.outcome = outcome;
    this.code = code;
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const text = (res: ServerResponse, status: number, body: string): void => {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
  res.end(body);
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void => {
  const payload = {
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

const incrementIngestStatus = (metrics: MetricsStore, ingestStatus: string): void => {
  switch (ingestStatus) {
    case "ACCEPTED":
      metrics.webhookIngestAcceptedTotal += 1;
      return;
    case "DUPLICATE":
      metrics.webhookIngestDuplicateTotal += 1;
      return;
    case "IGNORED":
      metrics.webhookIngestIgnoredTotal += 1;
      return;
    default:
      throw new Error(`Unsupported ingest status: ${ingestStatus}`);
  }
};

const ensureActionPayload = (action: BotAction): void => {
  if (!action.payload || typeof action.payload.comment_markdown !== "string" || !action.payload.comment_markdown.trim()) {
    throw new BotActionExecutionError(
      `Action ${action.id} missing payload.comment_markdown`,
      "FAILED",
      "INVALID_ACTION_PAYLOAD",
    );
  }
  if (!action.payload.comment_marker || !action.payload.comment_marker.trim()) {
    throw new BotActionExecutionError(
      `Action ${action.id} missing payload.comment_marker`,
      "FAILED",
      "INVALID_ACTION_PAYLOAD",
    );
  }
  if (!action.repo_full_name || typeof action.repo_full_name !== "string") {
    throw new BotActionExecutionError(`Action ${action.id} missing repo_full_name`, "FAILED", "INVALID_ACTION_PAYLOAD");
  }
  if (typeof action.installation_id !== "number" || action.installation_id <= 0) {
    throw new BotActionExecutionError(
      `Action ${action.id} has invalid installation_id`,
      "FAILED",
      "INVALID_ACTION_PAYLOAD",
    );
  }
  if (typeof action.github_pr_number !== "number" || action.github_pr_number <= 0) {
    throw new BotActionExecutionError(
      `Action ${action.id} has invalid github_pr_number`,
      "FAILED",
      "INVALID_ACTION_PAYLOAD",
    );
  }
};

const executeOutboxAction = async (ctx: AppContext, action: BotAction): Promise<void> => {
  ensureActionPayload(action);

  if (action.action_type === "UPSERT_PR_COMMENT") {
    await ctx.github.upsertPrComment(
      action.installation_id,
      action.repo_full_name,
      action.github_pr_number,
      action.payload.comment_marker,
      action.payload.comment_markdown,
    );
    return;
  }

  if (action.action_type === "CLOSE_PR_WITH_COMMENT") {
    await ctx.github.closePullRequest(action.installation_id, action.repo_full_name, action.github_pr_number);
    await ctx.github.upsertPrComment(
      action.installation_id,
      action.repo_full_name,
      action.github_pr_number,
      action.payload.comment_marker,
      action.payload.comment_markdown,
    );
    return;
  }

  throw new BotActionExecutionError(`Unsupported bot action type: ${action.action_type}`, "FAILED", "UNSUPPORTED_ACTION");
};

const classifyActionError = (error: unknown): BotActionExecutionError => {
  if (error instanceof BotActionExecutionError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("GitHub installation token request failed (404)") ||
    message.includes("GitHub repository installation lookup failed (404)") ||
    message.includes("GitHub repository installation lookup response missing id")
  ) {
    return new BotActionExecutionError(message, "FAILED", "INSTALLATION_NOT_FOUND");
  }
  return new BotActionExecutionError(message, "RETRYABLE_FAILURE", "EXECUTION_ERROR");
};

const runOutboxPollTick = async (ctx: AppContext): Promise<void> => {
  ctx.metrics.outboxClaimTotal += 1;
  const claimed = await ctx.backend.claimBotActions(ctx.config.workerId, ctx.config.outboxClaimLimit);
  const actions = claimed.actions ?? [];
  ctx.metrics.outboxActionsClaimedTotal += actions.length;

  if (actions.length > 0) {
    log("info", "outbox.claimed", {
      worker_id: ctx.config.workerId,
      count: actions.length,
    });
  }

  for (const action of actions) {
    try {
      await executeOutboxAction(ctx, action);
      await ctx.backend.postBotActionResult(action.id, ctx.config.workerId, "SUCCEEDED", null, null);
      ctx.metrics.outboxActionsSuccessTotal += 1;
      log("info", "outbox.action_succeeded", {
        action_id: action.id,
        action_type: action.action_type,
      });
    } catch (error) {
      const classified = classifyActionError(error);
      if (classified.outcome === "FAILED") {
        ctx.metrics.outboxActionsFailedTotal += 1;
      } else {
        ctx.metrics.outboxActionsRetryableFailureTotal += 1;
      }

      log("error", "outbox.action_failed", {
        action_id: action.id,
        action_type: action.action_type,
        outcome: classified.outcome,
        failure_code: classified.code,
        error: classified.message,
      });

      try {
        await ctx.backend.postBotActionResult(
          action.id,
          ctx.config.workerId,
          classified.outcome,
          classified.code,
          classified.message,
        );
      } catch (ackError) {
        ctx.metrics.errorsTotal += 1;
        log("error", "outbox.ack_failed", {
          action_id: action.id,
          error: ackError instanceof Error ? ackError.message : String(ackError),
        });
      }
    }
  }
};

const shouldBackfillInstallationRepos = (event: NormalizedInstallationSyncEvent): boolean => {
  if (event.event_name !== "installation") {
    return false;
  }
  if (event.action !== "created" && event.action !== "unsuspend") {
    return false;
  }
  return event.repositories.length === 0;
};

const withInstallationRepositories = async (
  ctx: AppContext,
  event: NormalizedInstallationSyncEvent,
): Promise<NormalizedInstallationSyncEvent> => {
  if (!shouldBackfillInstallationRepos(event)) {
    return event;
  }

  const repositories = await ctx.github.listInstallationRepositories(event.installation.id);
  log("info", "webhook.installation_repo_backfill", {
    delivery_id: event.delivery_id,
    installation_id: event.installation.id,
    repositories_found: repositories.length,
  });

  return {
    ...event,
    repositories,
  };
};

const handleWebhook = async (ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rawBody = await readBody(req);
  const event = parseGitHubWebhookEvent(req.headers, rawBody, ctx.config.githubWebhookSecret);
  ctx.metrics.webhookEventsTotal += 1;

  if (!event) {
    ctx.metrics.webhookIgnoredTotal += 1;
    json(res, 202, { status: "ignored" });
    return;
  }

  if (event.event_name === "pull_request") {
    ctx.metrics.webhookPullRequestForwardedTotal += 1;
    const response = await ctx.backend.postPullRequestEvent(event.payload);
    incrementIngestStatus(ctx.metrics, response.ingest_status);
    log("info", "webhook.pull_request_forwarded", {
      delivery_id: event.payload.delivery_id,
      repo_full_name: event.payload.repository.full_name,
      pr_number: event.payload.pull_request.number,
      ingest_status: response.ingest_status,
    });
    json(res, 200, { status: "ok", ingest_status: response.ingest_status });
    return;
  }

  ctx.metrics.webhookInstallationSyncForwardedTotal += 1;
  const enriched = await withInstallationRepositories(ctx, event.payload);
  const response = await ctx.backend.postInstallationSyncEvent(enriched);
  incrementIngestStatus(ctx.metrics, response.ingest_status);
  log("info", "webhook.installation_sync_forwarded", {
    delivery_id: enriched.delivery_id,
    event_name: enriched.event_name,
    action: enriched.action,
    installation_id: enriched.installation.id,
    repositories: enriched.repositories.length,
    ingest_status: response.ingest_status,
  });
  json(res, 200, { status: "ok", ingest_status: response.ingest_status });
};

export const createAppServer = (config: AppConfig) => {
  const backend = new BackendClient({
    baseUrl: config.backendBaseUrl,
    serviceToken: config.backendServiceToken,
    botKeyId: config.backendBotKeyId,
    internalHmacSecret: config.backendInternalHmacSecret,
  });
  const github = new GitHubClient({
    appId: config.githubAppId,
    privateKeyPem: config.githubAppPrivateKey,
    apiBaseUrl: config.githubApiBaseUrl,
  });

  const metrics: MetricsStore = {
    webhookEventsTotal: 0,
    webhookIgnoredTotal: 0,
    webhookPullRequestForwardedTotal: 0,
    webhookInstallationSyncForwardedTotal: 0,
    webhookIngestAcceptedTotal: 0,
    webhookIngestDuplicateTotal: 0,
    webhookIngestIgnoredTotal: 0,
    outboxClaimTotal: 0,
    outboxActionsClaimedTotal: 0,
    outboxActionsSuccessTotal: 0,
    outboxActionsRetryableFailureTotal: 0,
    outboxActionsFailedTotal: 0,
    errorsTotal: 0,
  };

  const appCtx: AppContext = {
    config,
    backend,
    github,
    metrics,
  };

  if (config.outboxPollingEnabled) {
    let running = false;
    const tick = async (): Promise<void> => {
      if (running) {
        return;
      }
      running = true;
      try {
        await runOutboxPollTick(appCtx);
      } catch (error) {
        appCtx.metrics.errorsTotal += 1;
        log("error", "outbox.poll_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running = false;
      }
    };

    void tick();
    const interval = setInterval(() => {
      void tick();
    }, config.outboxPollIntervalMs);
    interval.unref?.();

    log("info", "startup.outbox_polling_enabled", {
      worker_id: config.workerId,
      interval_ms: config.outboxPollIntervalMs,
      claim_limit: config.outboxClaimLimit,
    });
  } else {
    log("info", "startup.outbox_polling_disabled");
  }

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      if (method === "POST" && url.pathname === "/webhooks/github") {
        await handleWebhook(appCtx, req, res);
        return;
      }
      if (method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { status: "ok" });
        return;
      }
      if (method === "GET" && url.pathname === "/metrics") {
        text(
          res,
          200,
          [
            "# TYPE sitg_bot_webhook_events_total counter",
            `sitg_bot_webhook_events_total ${appCtx.metrics.webhookEventsTotal}`,
            "# TYPE sitg_bot_webhook_ignored_total counter",
            `sitg_bot_webhook_ignored_total ${appCtx.metrics.webhookIgnoredTotal}`,
            "# TYPE sitg_bot_webhook_pull_request_forwarded_total counter",
            `sitg_bot_webhook_pull_request_forwarded_total ${appCtx.metrics.webhookPullRequestForwardedTotal}`,
            "# TYPE sitg_bot_webhook_installation_sync_forwarded_total counter",
            `sitg_bot_webhook_installation_sync_forwarded_total ${appCtx.metrics.webhookInstallationSyncForwardedTotal}`,
            "# TYPE sitg_bot_webhook_ingest_accepted_total counter",
            `sitg_bot_webhook_ingest_accepted_total ${appCtx.metrics.webhookIngestAcceptedTotal}`,
            "# TYPE sitg_bot_webhook_ingest_duplicate_total counter",
            `sitg_bot_webhook_ingest_duplicate_total ${appCtx.metrics.webhookIngestDuplicateTotal}`,
            "# TYPE sitg_bot_webhook_ingest_ignored_total counter",
            `sitg_bot_webhook_ingest_ignored_total ${appCtx.metrics.webhookIngestIgnoredTotal}`,
            "# TYPE sitg_bot_outbox_claim_total counter",
            `sitg_bot_outbox_claim_total ${appCtx.metrics.outboxClaimTotal}`,
            "# TYPE sitg_bot_outbox_actions_claimed_total counter",
            `sitg_bot_outbox_actions_claimed_total ${appCtx.metrics.outboxActionsClaimedTotal}`,
            "# TYPE sitg_bot_outbox_actions_success_total counter",
            `sitg_bot_outbox_actions_success_total ${appCtx.metrics.outboxActionsSuccessTotal}`,
            "# TYPE sitg_bot_outbox_actions_retryable_failure_total counter",
            `sitg_bot_outbox_actions_retryable_failure_total ${appCtx.metrics.outboxActionsRetryableFailureTotal}`,
            "# TYPE sitg_bot_outbox_actions_failed_total counter",
            `sitg_bot_outbox_actions_failed_total ${appCtx.metrics.outboxActionsFailedTotal}`,
            "# TYPE sitg_bot_errors_total counter",
            `sitg_bot_errors_total ${appCtx.metrics.errorsTotal}`,
            "",
          ].join("\n"),
        );
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      appCtx.metrics.errorsTotal += 1;
      log("error", "request.failed", {
        method: req.method,
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
      json(res, 500, { error: "internal_error" });
    }
  });

  return server;
};
