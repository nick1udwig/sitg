import type { IncomingHttpHeaders } from "node:http";
import { verifyGitHubWebhookSignature } from "./crypto.js";
import type { NormalizedPrEvent, PrAction } from "./types.js";

const SUPPORTED_ACTIONS = new Set<PrAction>(["opened", "reopened", "synchronize"]);

type GithubWebhookPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; full_name?: string };
  pull_request?: {
    number?: number;
    id?: number;
    html_url?: string;
    draft?: boolean;
    user?: { id?: number; login?: string };
    head?: { sha?: string };
  };
};

const headerValue = (headers: IncomingHttpHeaders, key: string): string | undefined => {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export const parsePullRequestEvent = (
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
  nowIso = new Date().toISOString(),
): NormalizedPrEvent | null => {
  const signature = headerValue(headers, "x-hub-signature-256");
  if (!verifyGitHubWebhookSignature(secret, rawBody, signature)) {
    return null;
  }

  const eventType = headerValue(headers, "x-github-event");
  if (eventType !== "pull_request") {
    return null;
  }

  const deliveryId = headerValue(headers, "x-github-delivery");
  if (!deliveryId) {
    return null;
  }

  let payload: GithubWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GithubWebhookPayload;
  } catch {
    return null;
  }

  if (!payload.action || !SUPPORTED_ACTIONS.has(payload.action as PrAction)) {
    return null;
  }

  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const prId = payload.pull_request?.id;
  const prUrl = payload.pull_request?.html_url;
  const prAuthorId = payload.pull_request?.user?.id;
  const prAuthorLogin = payload.pull_request?.user?.login;
  const prHeadSha = payload.pull_request?.head?.sha;

  if (
    typeof installationId !== "number" ||
    typeof repoId !== "number" ||
    typeof repoFullName !== "string" ||
    typeof prNumber !== "number" ||
    typeof prId !== "number" ||
    typeof prUrl !== "string" ||
    typeof prAuthorId !== "number" ||
    typeof prAuthorLogin !== "string" ||
    typeof prHeadSha !== "string"
  ) {
    return null;
  }

  return {
    delivery_id: deliveryId,
    installation_id: installationId,
    action: payload.action as PrAction,
    repository: {
      id: repoId,
      full_name: repoFullName,
    },
    pull_request: {
      number: prNumber,
      id: prId,
      html_url: prUrl,
      user: {
        id: prAuthorId,
        login: prAuthorLogin,
      },
      head_sha: prHeadSha,
      is_draft: Boolean(payload.pull_request?.draft),
    },
    event_time: nowIso,
  };
};

export const buildDeliveryDedupKey = (event: NormalizedPrEvent): string =>
  `${event.delivery_id}:${event.action}:${event.repository.id}:${event.pull_request.number}`;
