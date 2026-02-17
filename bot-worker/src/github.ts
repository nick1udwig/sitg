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
      throw new Error(`GitHub close pull request failed (${res.status})`);
    }
  }

  async listInstallationRepositories(installationId: number): Promise<InstallationRepositoryRef[]> {
    const token = await this.getInstallationToken(installationId);
    const repositories: InstallationRepositoryRef[] = [];
    let page = 1;

    while (page <= 10) {
      const res = await fetchWithRetry(
        `${this.apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
        {
          method: "GET",
          headers: this.defaultHeaders(token),
        },
      );
      if (!res.ok) {
        throw new Error(`GitHub list installation repositories failed (${res.status})`);
      }

      const body = (await res.json()) as InstallationRepositoriesResponse;
      const chunk = body.repositories ?? [];
      for (const repo of chunk) {
        if (typeof repo.id === "number" && typeof repo.full_name === "string") {
          repositories.push({ id: repo.id, full_name: repo.full_name });
        }
      }

      if (chunk.length < 100) {
        break;
      }
      page += 1;
    }

    return repositories;
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
        throw new Error(`GitHub update issue comment failed (${updateRes.status})`);
      }
      return;
    }

    const createRes = await fetchWithRetry(`${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: this.defaultHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (!createRes.ok) {
      throw new Error(`GitHub create issue comment failed (${createRes.status})`);
    }
  }

  private async findCommentByMarker(
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    marker: string,
  ): Promise<CommentRecord | null> {
    const res = await fetchWithRetry(
      `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
      {
        method: "GET",
        headers: this.defaultHeaders(token),
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub list issue comments failed (${res.status})`);
    }
    const comments = (await res.json()) as CommentRecord[];
    return comments.find((comment) => comment.body?.includes(marker)) ?? null;
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
      throw new Error(`GitHub repository installation lookup failed (${res.status})`);
    }
    const body = (await res.json()) as { id?: number };
    if (typeof body.id !== "number" || body.id <= 0) {
      throw new Error("GitHub repository installation lookup response missing id");
    }
    return body.id;
  }

  private async getInstallationToken(installationId: number, repoFullName?: string): Promise<string> {
    const jwt = signGitHubAppJwt(this.appId, this.privateKeyPem);
    const requestToken = (targetInstallationId: number): Promise<Response> =>
      fetchWithRetry(`${this.apiBaseUrl}/app/installations/${targetInstallationId}/access_tokens`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
        },
      });

    let res = await requestToken(installationId);
    if (!res.ok && res.status === 404 && repoFullName) {
      const resolvedInstallationId = await this.resolveInstallationIdForRepo(jwt, repoFullName);
      if (resolvedInstallationId && resolvedInstallationId !== installationId) {
        res = await requestToken(resolvedInstallationId);
      }
    }

    if (!res.ok) {
      throw new Error(`GitHub installation token request failed (${res.status})`);
    }
    const body = (await res.json()) as { token: string };
    if (!body.token) {
      throw new Error("GitHub installation token response missing token");
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
