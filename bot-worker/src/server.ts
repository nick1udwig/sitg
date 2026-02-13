import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { BackendClient } from "./backend.js";
import type { AppConfig } from "./config.js";
import { DeadlineScheduler } from "./deadlines.js";
import { GitHubClient } from "./github.js";
import { DeliveryIdempotencyStore } from "./idempotency.js";
import { BotStateStore } from "./persistence.js";
import type { DeadlineCheckResponse, NormalizedPrEvent, PrEventDecisionResponse } from "./types.js";
import { buildDeliveryDedupKey, parsePullRequestEvent } from "./webhook.js";

type AppContext = {
  config: AppConfig;
  backend: BackendClient;
  github: GitHubClient;
  dedupStore: DeliveryIdempotencyStore;
  scheduler: DeadlineScheduler;
  stateStore: BotStateStore;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

const runDeadlineForChallenge = async (ctx: AppContext, challengeId: string): Promise<void> => {
  const scheduled = ctx.scheduler.get(challengeId);
  const deadlineResponse = await ctx.backend.deadlineCheck(challengeId);

  if (!isCloseDecision(deadlineResponse)) {
    ctx.scheduler.cancel(challengeId);
    ctx.stateStore.removeDeadline(challengeId);
    return;
  }

  const close = deadlineResponse.close;
  if (!close) {
    throw new Error(`Deadline response for ${challengeId} missing close payload`);
  }

  const remembered = ctx.stateStore.getRepoInstallation(close.github_repo_id);
  const installationId = scheduled?.installationId ?? remembered?.installationId;
  if (!installationId) {
    throw new Error(`Missing installation mapping for repo ${close.github_repo_id}; cannot close PR`);
  }

  const repoFullName = await resolveRepoFullName(
    ctx,
    installationId,
    close.github_repo_id,
    scheduled?.repoFullName ?? remembered?.fullName,
  );

  await ctx.github.closePullRequest(installationId, repoFullName, close.github_pr_number);
  await ctx.github.upsertTimeoutComment(
    installationId,
    repoFullName,
    close.github_pr_number,
    challengeId,
    close.comment_markdown ?? timeoutFallbackComment(),
  );
  ctx.scheduler.cancel(challengeId);
  ctx.stateStore.removeDeadline(challengeId);
};

const handleWebhook = async (ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rawBody = await readBody(req);
  const event = parsePullRequestEvent(req.headers, rawBody, ctx.config.githubWebhookSecret);
  if (!event) {
    json(res, 202, { status: "ignored" });
    return;
  }

  const dedupKey = buildDeliveryDedupKey(event);
  if (ctx.dedupStore.has(dedupKey)) {
    json(res, 200, { status: "duplicate" });
    return;
  }

  ctx.stateStore.rememberRepoInstallation(event.repository.id, event.installation_id, event.repository.full_name);

  const decision = await ctx.backend.postPrEvent(event);
  switch (decision.decision) {
    case "REQUIRE_STAKE":
      await applyRequireStakeDecision(ctx, event, decision);
      break;
    case "EXEMPT":
      await applyExemptDecision(ctx, event, decision);
      break;
    case "ALREADY_VERIFIED":
    case "IGNORE":
      break;
    default:
      throw new Error(`Unsupported backend decision: ${String((decision as { decision: string }).decision)}`);
  }

  ctx.dedupStore.add(dedupKey);
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
  });
  const github = new GitHubClient({
    appId: config.githubAppId,
    privateKeyPem: config.githubAppPrivateKey,
  });
  const stateStore = new BotStateStore(config.stateFilePath);
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
  };

  for (const pending of stateStore.getPendingDeadlines()) {
    scheduler.ensure(pending);
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
      json(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(error);
      json(res, 500, { error: "internal_error" });
    }
  });

  return server;
};
