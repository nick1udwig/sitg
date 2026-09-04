import type { IncomingHttpHeaders } from "node:http";
import { verifyGitHubWebhookSignature } from "./crypto.js";
import type {
  InstallationAccountType,
  InstallationAction,
  InstallationEventName,
  InstallationRepositoriesAction,
  InstallationRepositoryRef,
  NormalizedInstallationSyncEvent,
  NormalizedPrEvent,
  PrAction,
} from "./types.js";

const SUPPORTED_PR_ACTIONS = new Set<PrAction>(["opened", "reopened", "ready_for_review", "synchronize"]);
const SUPPORTED_INSTALLATION_ACTIONS = new Set<InstallationAction>(["created", "deleted", "suspend", "unsuspend"]);
const SUPPORTED_INSTALLATION_REPO_ACTIONS = new Set<InstallationRepositoriesAction>(["added", "removed"]);
const SUPPORTED_ACCOUNT_TYPES = new Set<InstallationAccountType>(["User", "Organization"]);

type PullRequestPayload = {
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

type InstallationPayload = {
  action?: string;
  installation?: {
    id?: number;
    account?: {
      login?: string;
      type?: string;
    };
  };
  repositories_added?: Array<{ id?: number; full_name?: string }>;
  repositories_removed?: Array<{ id?: number; full_name?: string }>;
  repositories?: Array<{ id?: number; full_name?: string }>;
};

export type NormalizedGitHubWebhookEvent =
  | {
      event_name: "pull_request";
      payload: NormalizedPrEvent;
    }
  | {
      event_name: InstallationEventName;
      payload: NormalizedInstallationSyncEvent;
    };

const headerValue = (headers: IncomingHttpHeaders, key: string): string | undefined => {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const parseRepositoryRefs = (value: unknown): InstallationRepositoryRef[] | null => {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: InstallationRepositoryRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const repoId = (item as { id?: unknown }).id;
    const fullName = (item as { full_name?: unknown }).full_name;
    if (typeof repoId !== "number" || typeof fullName !== "string") {
      return null;
    }
    parsed.push({ id: repoId, full_name: fullName });
  }

  return parsed;
};

const parseInstallationId = (installation: PullRequestPayload["installation"]): number | null => {
  if (!installation || typeof installation.id !== "number") {
    return null;
  }
  return installation.id;
};

const parsePullRequestRepository = (
  repository: PullRequestPayload["repository"],
): NormalizedPrEvent["repository"] | null => {
  if (!repository || typeof repository.id !== "number" || typeof repository.full_name !== "string") {
    return null;
  }
  return { id: repository.id, full_name: repository.full_name };
};

const parsePullRequestDetails = (
  pullRequest: PullRequestPayload["pull_request"],
): NormalizedPrEvent["pull_request"] | null => {
  if (!pullRequest || !pullRequest.user || !pullRequest.head) {
    return null;
  }

  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.id !== "number" ||
    typeof pullRequest.html_url !== "string" ||
    typeof pullRequest.user.id !== "number" ||
    typeof pullRequest.user.login !== "string" ||
    typeof pullRequest.head.sha !== "string"
  ) {
    return null;
  }

  return {
    number: pullRequest.number,
    id: pullRequest.id,
    html_url: pullRequest.html_url,
    user: {
      id: pullRequest.user.id,
      login: pullRequest.user.login,
    },
    head_sha: pullRequest.head.sha,
    is_draft: Boolean(pullRequest.draft),
  };
};

const parsePullRequestEvent = (
  deliveryId: string,
  rawBody: Buffer,
  nowIso: string,
): NormalizedPrEvent | null => {
  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as PullRequestPayload;
  } catch {
    return null;
  }

  if (!payload.action || !SUPPORTED_PR_ACTIONS.has(payload.action as PrAction)) {
    return null;
  }

  const installationId = parseInstallationId(payload.installation);
  const repository = parsePullRequestRepository(payload.repository);
  const pullRequest = parsePullRequestDetails(payload.pull_request);
  if (installationId === null || !repository || !pullRequest) {
    return null;
  }

  return {
    delivery_id: deliveryId,
    installation_id: installationId,
    action: payload.action as PrAction,
    repository,
    pull_request: pullRequest,
    event_time: nowIso,
  };
};

const parseInstallationSyncEvent = (
  eventName: InstallationEventName,
  deliveryId: string,
  rawBody: Buffer,
  nowIso: string,
): NormalizedInstallationSyncEvent | null => {
  let payload: InstallationPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as InstallationPayload;
  } catch {
    return null;
  }

  if (!payload.action) {
    return null;
  }

  if (eventName === "installation" && !SUPPORTED_INSTALLATION_ACTIONS.has(payload.action as InstallationAction)) {
    return null;
  }

  if (
    eventName === "installation_repositories" &&
    !SUPPORTED_INSTALLATION_REPO_ACTIONS.has(payload.action as InstallationRepositoriesAction)
  ) {
    return null;
  }

  const installationId = payload.installation?.id;
  const accountLogin = payload.installation?.account?.login;
  const accountType = payload.installation?.account?.type;

  if (
    typeof installationId !== "number" ||
    typeof accountLogin !== "string" ||
    typeof accountType !== "string" ||
    !SUPPORTED_ACCOUNT_TYPES.has(accountType as InstallationAccountType)
  ) {
    return null;
  }

  const repositoriesAdded = parseRepositoryRefs(payload.repositories_added);
  const repositoriesRemoved = parseRepositoryRefs(payload.repositories_removed);
  const repositories = parseRepositoryRefs(payload.repositories);
  if (!repositoriesAdded || !repositoriesRemoved || !repositories) {
    return null;
  }

  return {
    delivery_id: deliveryId,
    event_time: nowIso,
    event_name: eventName,
    action: payload.action as InstallationAction | InstallationRepositoriesAction,
    installation: {
      id: installationId,
      account_login: accountLogin,
      account_type: accountType as InstallationAccountType,
    },
    repositories_added: repositoriesAdded,
    repositories_removed: repositoriesRemoved,
    repositories,
  };
};

export const parseGitHubWebhookEvent = (
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
  nowIso = new Date().toISOString(),
): NormalizedGitHubWebhookEvent | null => {
  const signature = headerValue(headers, "x-hub-signature-256");
  if (!verifyGitHubWebhookSignature(secret, rawBody, signature)) {
    return null;
  }

  const eventType = headerValue(headers, "x-github-event");
  const deliveryId = headerValue(headers, "x-github-delivery");
  if (!eventType || !deliveryId) {
    return null;
  }

  if (eventType === "pull_request") {
    const payload = parsePullRequestEvent(deliveryId, rawBody, nowIso);
    if (!payload) {
      return null;
    }
    return { event_name: "pull_request", payload };
  }

  if (eventType === "installation" || eventType === "installation_repositories") {
    const payload = parseInstallationSyncEvent(eventType, deliveryId, rawBody, nowIso);
    if (!payload) {
      return null;
    }
    return { event_name: eventType, payload };
  }

  return null;
};
