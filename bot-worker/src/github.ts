import { signGitHubAppJwt } from "./crypto.js";
import { fetchWithRetry } from "./retry.js";

type GitHubClientOptions = {
  appId: string;
  privateKeyPem: string;
  apiBaseUrl: string;
};

type RepoRef = {
  owner: string;
  repo: string;
};

type CommentRecord = {
  id: number;
  body: string;
};

type InstallationRepositoriesResponse = {
  repositories?: Array<{ id?: number; full_name?: string }>;
  total_count?: number;
};

type InstallationRepositoryRef = {
  id: number;
  full_name: string;
};

type CachedInstallationToken = {
  token: string;
  usableUntilMs: number;
};

const RESULTS_PER_PAGE = 100;
const PAGINATION_PAGE_LIMIT = 100;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const TOKEN_FALLBACK_TTL_MS = 5 * 60_000;

export class GitHubApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = "GitHubApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

const githubHttpError = (operation: string, response: Response): GitHubApiError => {
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"));
  const retryable =
    rateLimited || response.status === 408 || response.status === 409 || response.status === 425 || response.status >= 500;
  const installationMissing = response.status === 404 && operation.includes("installation");
  return new GitHubApiError(
    `GitHub ${operation} failed (${response.status})`,
    installationMissing ? "INSTALLATION_NOT_FOUND" : `GITHUB_HTTP_${response.status}`,
    retryable,
  );
};

const githubProtocolError = (message: string, code = "INVALID_GITHUB_RESPONSE"): GitHubApiError =>
  new GitHubApiError(message, code, false);

const parseRepo = (fullName: string): RepoRef => {
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`Invalid repository full name: ${fullName}`);
  }
  return { owner, repo };
};

const ensureMarker = (marker: string): string => {
  const trimmed = marker.trim();
  if (!trimmed) {
    throw new Error("comment_marker is required");
  }
  return trimmed.startsWith("<!--") ? trimmed : `<!-- ${trimmed} -->`;
};

export class GitHubClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly apiBaseUrl: string;
  private readonly installationTokenCache = new Map<number, CachedInstallationToken>();
  private readonly installationTokenRequests = new Map<number, Promise<string>>();

  constructor(options: GitHubClientOptions) {
    this.appId = options.appId;
    this.privateKeyPem = options.privateKeyPem;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  }

  async upsertPrComment(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    commentMarker: string,
    commentMarkdown: string,
  ): Promise<void> {
    await this.upsertIssueComment(installationId, repoFullName, prNumber, ensureMarker(commentMarker), commentMarkdown);
  }

  async closePullRequest(installationId: number, repoFullName: string, prNumber: number): Promise<void> {
    const token = await this.getInstallationToken(installationId, repoFullName);
    const { owner, repo } = parseRepo(repoFullName);
    const res = await fetchWithRetry(`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: this.defaultHeaders(token),
      body: JSON.stringify({ state: "closed" }),
    });
    if (!res.ok) {
      throw githubHttpError("close pull request", res);
    }
  }

  async listInstallationRepositories(installationId: number): Promise<InstallationRepositoryRef[]> {
    const token = await this.getInstallationToken(installationId);
    const repositories: InstallationRepositoryRef[] = [];
    let fetchedCount = 0;

    for (let page = 1; page <= PAGINATION_PAGE_LIMIT; page += 1) {
      const res = await fetchWithRetry(
        `${this.apiBaseUrl}/installation/repositories?per_page=${RESULTS_PER_PAGE}&page=${page}`,
        {
          method: "GET",
          headers: this.defaultHeaders(token),
        },
      );
      if (!res.ok) {
        throw githubHttpError("list installation repositories", res);
      }

      const body = (await res.json()) as InstallationRepositoriesResponse;
      const chunk = body.repositories ?? [];
      fetchedCount += chunk.length;
      for (const repo of chunk) {
        if (typeof repo.id === "number" && typeof repo.full_name === "string") {
          repositories.push({ id: repo.id, full_name: repo.full_name });
        }
      }

      if (
        chunk.length < RESULTS_PER_PAGE ||
        (typeof body.total_count === "number" && fetchedCount >= body.total_count)
      ) {
        return repositories;
      }
    }

    throw githubProtocolError(
      `GitHub installation repository listing exceeded ${PAGINATION_PAGE_LIMIT} pages`,
      "GITHUB_PAGINATION_LIMIT",
    );
  }

  private async upsertIssueComment(
    installationId: number,
    repoFullName: string,
    issueNumber: number,
    marker: string,
    markdown: string,
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId, repoFullName);
    const { owner, repo } = parseRepo(repoFullName);
    const body = `${markdown.trim()}\n\n${marker}`;

    const existing = await this.findCommentByMarker(token, owner, repo, issueNumber, marker);
    if (existing) {
      const updateRes = await fetchWithRetry(`${this.apiBaseUrl}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers: this.defaultHeaders(token),
        body: JSON.stringify({ body }),
      });
      if (!updateRes.ok) {
        throw githubHttpError("update issue comment", updateRes);
      }
      return;
    }

    const createRes = await fetchWithRetry(`${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: this.defaultHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (!createRes.ok) {
      throw githubHttpError("create issue comment", createRes);
    }
  }

  private async findCommentByMarker(
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    marker: string,
  ): Promise<CommentRecord | null> {
    for (let page = 1; page <= PAGINATION_PAGE_LIMIT; page += 1) {
      const res = await fetchWithRetry(
        `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${RESULTS_PER_PAGE}&page=${page}`,
        {
          method: "GET",
          headers: this.defaultHeaders(token),
        },
      );
      if (!res.ok) {
        throw githubHttpError("list issue comments", res);
      }
      const comments = (await res.json()) as CommentRecord[];
      const existing = comments.find((comment) => comment.body?.includes(marker));
      if (existing) {
        return existing;
      }
      if (comments.length < RESULTS_PER_PAGE) {
        return null;
      }
    }

    throw githubProtocolError(
      `GitHub issue comment listing exceeded ${PAGINATION_PAGE_LIMIT} pages`,
      "GITHUB_PAGINATION_LIMIT",
    );
  }

  private async resolveInstallationIdForRepo(jwt: string, repoFullName: string): Promise<number | null> {
    const { owner, repo } = parseRepo(repoFullName);
    const res = await fetchWithRetry(`${this.apiBaseUrl}/repos/${owner}/${repo}/installation`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw githubHttpError("repository installation lookup", res);
    }
    const body = (await res.json()) as { id?: number };
    if (typeof body.id !== "number" || body.id <= 0) {
      throw githubProtocolError(
        "GitHub repository installation lookup response missing id",
        "INSTALLATION_NOT_FOUND",
      );
    }
    return body.id;
  }

  private async getInstallationToken(installationId: number, repoFullName?: string): Promise<string> {
    try {
      return await this.getInstallationTokenById(installationId);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "INSTALLATION_NOT_FOUND" || !repoFullName) {
        throw error;
      }

      const jwt = signGitHubAppJwt(this.appId, this.privateKeyPem);
      const resolvedInstallationId = await this.resolveInstallationIdForRepo(jwt, repoFullName);
      if (resolvedInstallationId && resolvedInstallationId !== installationId) {
        return this.getInstallationTokenById(resolvedInstallationId);
      }
      throw error;
    }
  }

  private async getInstallationTokenById(installationId: number): Promise<string> {
    const now = Date.now();
    for (const [cachedInstallationId, cachedToken] of this.installationTokenCache) {
      if (cachedToken.usableUntilMs <= now) {
        this.installationTokenCache.delete(cachedInstallationId);
      }
    }
    const cached = this.installationTokenCache.get(installationId);
    if (cached && cached.usableUntilMs > now) {
      return cached.token;
    }
    this.installationTokenCache.delete(installationId);

    const existingRequest = this.installationTokenRequests.get(installationId);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.fetchInstallationToken(installationId);
    this.installationTokenRequests.set(installationId, request);
    try {
      return await request;
    } finally {
      if (this.installationTokenRequests.get(installationId) === request) {
        this.installationTokenRequests.delete(installationId);
      }
    }
  }

  private async fetchInstallationToken(installationId: number): Promise<string> {
    const jwt = signGitHubAppJwt(this.appId, this.privateKeyPem);
    const res = await fetchWithRetry(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw githubHttpError("installation token request", res);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) {
      throw githubProtocolError("GitHub installation token response missing token");
    }

    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;
    const usableUntilMs = Number.isFinite(expiresAtMs)
      ? expiresAtMs - TOKEN_EXPIRY_SKEW_MS
      : Date.now() + TOKEN_FALLBACK_TTL_MS;
    if (usableUntilMs > Date.now()) {
      this.installationTokenCache.set(installationId, {
        token: body.token,
        usableUntilMs,
      });
    }
    return body.token;
  }

  private defaultHeaders(token: string): HeadersInit {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "sitg-bot-worker",
    };
  }
}
