import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { BackendClient } from "./backend.js";
import type { AppConfig } from "./config.js";
import { DeadlineScheduler } from "./deadlines.js";
import { GitHubClient } from "./github.js";
import { DeliveryIdempotencyStore } from "./idempotency.js";
import { BotStateStore } from "./persistence.js";
import type { BotAction, DeadlineCheckResponse, NormalizedPrEvent, PrEventDecisionResponse } from "./types.js";
import { buildDeliveryDedupKey, parsePullRequestEvent } from "./webhook.js";

type AppContext = {
  config: AppConfig;
  backend: BackendClient;
  github: GitHubClient;
  dedupStore: DeliveryIdempotencyStore;
  scheduler: DeadlineScheduler;
  stateStore: BotStateStore;
  metrics: MetricsStore;
};

type MetricsStore = {
  webhookEventsTotal: number;
  webhookIgnoredTotal: number;
  webhookDuplicateTotal: number;
  webhookDecisionRequireStakeTotal: number;
  webhookDecisionExemptTotal: number;
  webhookDecisionAlreadyVerifiedTotal: number;
  webhookDecisionIgnoreTotal: number;
  deadlineRunTotal: number;
  deadlineCloseTotal: number;
  deadlineNoopTotal: number;
  outboxClaimTotal: number;
  outboxActionsClaimedTotal: number;
  outboxActionsSuccessTotal: number;
  outboxActionsFailedTotal: number;
  errorsTotal: number;
};

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

const timeoutFallbackComment = (): string =>
  "This PR was automatically closed because stake verification was not completed within 30 minutes.";

const applyRequireStakeDecision = async (
  ctx: AppContext,
  event: NormalizedPrEvent,
  decision: PrEventDecisionResponse,
): Promise<void> => {
  const challenge = decision.challenge;
  if (!challenge) {
    throw new Error("Backend decision REQUIRE_STAKE missing challenge payload");
  }

  await ctx.github.upsertGateComment(
    event.installation_id,
    event.repository.full_name,
    event.pull_request.number,
    challenge.id,
    challenge.comment_markdown,
  );

  if (!ctx.config.enableLocalDeadlineTimers) {
    return;
  }

  const scheduled = {
    challengeId: challenge.id,
    installationId: event.installation_id,
    repoFullName: event.repository.full_name,
    prNumber: event.pull_request.number,
    deadlineAt: challenge.deadline_at,
  };
  ctx.scheduler.ensure(scheduled);
  ctx.stateStore.putDeadline(scheduled);
};

const applyExemptDecision = async (
  ctx: AppContext,
  event: NormalizedPrEvent,
  decision: PrEventDecisionResponse,
): Promise<void> => {
  if (!ctx.config.exemptCommentEnabled || !decision.challenge?.id) {
    return;
  }
  await ctx.github.upsertGateComment(
    event.installation_id,
    event.repository.full_name,
    event.pull_request.number,
    decision.challenge.id,
    "This PR author is exempt from stake requirements for this repository.",
  );
};

const isCloseDecision = (response: DeadlineCheckResponse): boolean => response.action === "CLOSE_PR";

const resolveRepoFullName = async (
  ctx: AppContext,
  installationId: number,
  repoId: number,
  fallback?: string,
): Promise<string> => {
  const remembered = ctx.stateStore.getRepoInstallation(repoId)?.fullName;
  if (remembered) {
    return remembered;
  }
  if (fallback) {
    return fallback;
  }
  const fullName = await ctx.github.getRepositoryFullNameById(installationId, repoId);
  ctx.stateStore.rememberRepoInstallation(repoId, installationId, fullName);
  return fullName;
};

const executeClosePr = async (
  ctx: AppContext,
  installationId: number,
  repoId: number,
  prNumber: number,
  challengeId: string,
  commentMarkdown: string,
): Promise<void> => {
  const remembered = ctx.stateStore.getRepoInstallation(repoId);
  const repoFullName = await resolveRepoFullName(ctx, installationId, repoId, remembered?.fullName);
  await ctx.github.closePullRequest(installationId, repoFullName, prNumber);
  await ctx.github.upsertTimeoutComment(installationId, repoFullName, prNumber, challengeId, commentMarkdown);
};

const resolveInstallationIdForRepo = (ctx: AppContext, repoId: number): number | null => {
  const remembered = ctx.stateStore.getRepoInstallation(repoId)?.installationId;
  if (remembered) {
    return remembered;
  }
  if (ctx.config.defaultInstallationId) {
    return ctx.config.defaultInstallationId;
  }
  return null;
};

const runDeadlineForChallenge = async (ctx: AppContext, challengeId: string): Promise<void> => {
  ctx.metrics.deadlineRunTotal += 1;
  const scheduled = ctx.scheduler.get(challengeId);
  const deadlineResponse = await ctx.backend.deadlineCheck(challengeId);

  if (!isCloseDecision(deadlineResponse)) {
    ctx.metrics.deadlineNoopTotal += 1;
    ctx.scheduler.cancel(challengeId);
    ctx.stateStore.removeDeadline(challengeId);
    log("info", "deadline.noop", { challenge_id: challengeId });
    return;
  }

  const close = deadlineResponse.close;
  if (!close) {
    throw new Error(`Deadline response for ${challengeId} missing close payload`);
  }

  const remembered = ctx.stateStore.getRepoInstallation(close.github_repo_id);
  const installationId = scheduled?.installationId ?? remembered?.installationId ?? ctx.config.defaultInstallationId;
  if (!installationId) {
    throw new Error(`Missing installation mapping for repo ${close.github_repo_id}; cannot close PR`);
  }

  await executeClosePr(
    ctx,
    installationId,
    close.github_repo_id,
    close.github_pr_number,
    challengeId,
    close.comment_markdown ?? timeoutFallbackComment(),
  );

  ctx.scheduler.cancel(challengeId);
  ctx.stateStore.removeDeadline(challengeId);
  ctx.metrics.deadlineCloseTotal += 1;
  log("info", "deadline.closed_pr", {
    challenge_id: challengeId,
    repo_id: close.github_repo_id,
    pr_number: close.github_pr_number,
  });
};

const executeOutboxAction = async (ctx: AppContext, action: BotAction): Promise<void> => {
  if (action.action_type !== "CLOSE_PR") {
    throw new Error(`Unsupported bot action type: ${action.action_type}`);
  }

  const installationId = resolveInstallationIdForRepo(ctx, action.github_repo_id);
  if (!installationId) {
    throw new Error(
      `Missing installation mapping for repo ${action.github_repo_id}; set DEFAULT_INSTALLATION_ID or process webhook for this repo first`,
    );
  }

  await executeClosePr(
    ctx,
    installationId,
    action.github_repo_id,
    action.github_pr_number,
    action.challenge_id,
    action.payload?.comment_markdown ?? timeoutFallbackComment(),
  );
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
      await ctx.backend.postBotActionResult(action.id, ctx.config.workerId, true, null, null);
      ctx.metrics.outboxActionsSuccessTotal += 1;
      log("info", "outbox.action_succeeded", {
        action_id: action.id,
        action_type: action.action_type,
        challenge_id: action.challenge_id,
      });
    } catch (error) {
      ctx.metrics.outboxActionsFailedTotal += 1;
      const reason = error instanceof Error ? error.message : String(error);
      log("error", "outbox.action_failed", {
        action_id: action.id,
        action_type: action.action_type,
        error: reason,
      });
      try {
        await ctx.backend.postBotActionResult(action.id, ctx.config.workerId, false, reason, true);
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

const handleWebhook = async (ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rawBody = await readBody(req);
  const event = parsePullRequestEvent(req.headers, rawBody, ctx.config.githubWebhookSecret);
  ctx.metrics.webhookEventsTotal += 1;

  if (!event) {
    ctx.metrics.webhookIgnoredTotal += 1;
    json(res, 202, { status: "ignored" });
    return;
  }

  const dedupKey = buildDeliveryDedupKey(event);
  if (ctx.dedupStore.has(dedupKey)) {
    ctx.metrics.webhookDuplicateTotal += 1;
    json(res, 200, { status: "duplicate" });
    return;
  }

  ctx.stateStore.rememberRepoInstallation(event.repository.id, event.installation_id, event.repository.full_name);

  const decision = await ctx.backend.postPrEvent(event);
  switch (decision.decision) {
    case "REQUIRE_STAKE":
      ctx.metrics.webhookDecisionRequireStakeTotal += 1;
      await applyRequireStakeDecision(ctx, event, decision);
      break;
    case "EXEMPT":
      ctx.metrics.webhookDecisionExemptTotal += 1;
      await applyExemptDecision(ctx, event, decision);
      break;
    case "ALREADY_VERIFIED":
      ctx.metrics.webhookDecisionAlreadyVerifiedTotal += 1;
      break;
    case "IGNORE":
      ctx.metrics.webhookDecisionIgnoreTotal += 1;
      break;
    default:
      throw new Error(`Unsupported backend decision: ${String((decision as { decision: string }).decision)}`);
  }

  ctx.dedupStore.add(dedupKey);
  log("info", "webhook.decision_applied", {
    delivery_id: event.delivery_id,
    action: event.action,
    repo_full_name: event.repository.full_name,
    pr_number: event.pull_request.number,
    decision: decision.decision,
  });
  json(res, 200, { status: "ok", decision: decision.decision });
};

const isAuthorizedInternalRequest = (req: IncomingMessage, token?: string): boolean => {
  if (!token) {
    return true;
  }
  const headerValue = req.headers["x-internal-token"];
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return provided === token;
};

const handleDeadlineRoute = async (ctx: AppContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
  if (!isAuthorizedInternalRequest(req, ctx.config.deadlineInternalToken)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const match = path.match(/^\/internal\/v1\/deadlines\/([^/]+)\/run$/);
  if (!match) {
    json(res, 404, { error: "not_found" });
    return;
  }
  const challengeId = decodeURIComponent(match[1]);
  await runDeadlineForChallenge(ctx, challengeId);
  json(res, 200, { status: "ok" });
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
  const stateStore = new BotStateStore(config.stateFilePath);
  const metrics: MetricsStore = {
    webhookEventsTotal: 0,
    webhookIgnoredTotal: 0,
    webhookDuplicateTotal: 0,
    webhookDecisionRequireStakeTotal: 0,
    webhookDecisionExemptTotal: 0,
    webhookDecisionAlreadyVerifiedTotal: 0,
    webhookDecisionIgnoreTotal: 0,
    deadlineRunTotal: 0,
    deadlineCloseTotal: 0,
    deadlineNoopTotal: 0,
    outboxClaimTotal: 0,
    outboxActionsClaimedTotal: 0,
    outboxActionsSuccessTotal: 0,
    outboxActionsFailedTotal: 0,
    errorsTotal: 0,
  };
  let appCtx: AppContext;

  const scheduler = new DeadlineScheduler(async (challengeId: string) => {
    await runDeadlineForChallenge(appCtx, challengeId);
  });

  appCtx = {
    config,
    backend,
    github,
    dedupStore: new DeliveryIdempotencyStore(24 * 60 * 60 * 1000, stateStore),
    scheduler,
    stateStore,
    metrics,
  };

  const pendingDeadlines = stateStore.getPendingDeadlines();
  if (config.enableLocalDeadlineTimers) {
    for (const pending of pendingDeadlines) {
      scheduler.ensure(pending);
    }
  }
  if (pendingDeadlines.length > 0) {
    log("info", "startup.deadlines_loaded", {
      count: pendingDeadlines.length,
      local_timers_enabled: config.enableLocalDeadlineTimers,
    });
  }
  log("info", "startup.state_store", {
    mode: "file",
    path: config.stateFilePath,
    single_instance_only: true,
  });

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
      if (method === "POST" && url.pathname.startsWith("/internal/v1/deadlines/")) {
        await handleDeadlineRoute(appCtx, req, res, url.pathname);
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
            "# TYPE stc_bot_webhook_events_total counter",
            `stc_bot_webhook_events_total ${appCtx.metrics.webhookEventsTotal}`,
            "# TYPE stc_bot_webhook_ignored_total counter",
            `stc_bot_webhook_ignored_total ${appCtx.metrics.webhookIgnoredTotal}`,
            "# TYPE stc_bot_webhook_duplicate_total counter",
            `stc_bot_webhook_duplicate_total ${appCtx.metrics.webhookDuplicateTotal}`,
            "# TYPE stc_bot_webhook_decision_require_stake_total counter",
            `stc_bot_webhook_decision_require_stake_total ${appCtx.metrics.webhookDecisionRequireStakeTotal}`,
            "# TYPE stc_bot_webhook_decision_exempt_total counter",
            `stc_bot_webhook_decision_exempt_total ${appCtx.metrics.webhookDecisionExemptTotal}`,
            "# TYPE stc_bot_webhook_decision_already_verified_total counter",
            `stc_bot_webhook_decision_already_verified_total ${appCtx.metrics.webhookDecisionAlreadyVerifiedTotal}`,
            "# TYPE stc_bot_webhook_decision_ignore_total counter",
            `stc_bot_webhook_decision_ignore_total ${appCtx.metrics.webhookDecisionIgnoreTotal}`,
            "# TYPE stc_bot_deadline_run_total counter",
            `stc_bot_deadline_run_total ${appCtx.metrics.deadlineRunTotal}`,
            "# TYPE stc_bot_deadline_close_total counter",
            `stc_bot_deadline_close_total ${appCtx.metrics.deadlineCloseTotal}`,
            "# TYPE stc_bot_deadline_noop_total counter",
            `stc_bot_deadline_noop_total ${appCtx.metrics.deadlineNoopTotal}`,
            "# TYPE stc_bot_outbox_claim_total counter",
            `stc_bot_outbox_claim_total ${appCtx.metrics.outboxClaimTotal}`,
            "# TYPE stc_bot_outbox_actions_claimed_total counter",
            `stc_bot_outbox_actions_claimed_total ${appCtx.metrics.outboxActionsClaimedTotal}`,
            "# TYPE stc_bot_outbox_actions_success_total counter",
            `stc_bot_outbox_actions_success_total ${appCtx.metrics.outboxActionsSuccessTotal}`,
            "# TYPE stc_bot_outbox_actions_failed_total counter",
            `stc_bot_outbox_actions_failed_total ${appCtx.metrics.outboxActionsFailedTotal}`,
            "# TYPE stc_bot_errors_total counter",
            `stc_bot_errors_total ${appCtx.metrics.errorsTotal}`,
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
