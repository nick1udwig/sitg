import { signGitHubAppJwt } from "./crypto.js";
import { fetchWithRetry } from "./retry.js";

type GitHubClientOptions = {
  appId: string;
  privateKeyPem: string;
};

type RepoRef = {
  owner: string;
  repo: string;
};

type CommentRecord = {
  id: number;
  body: string;
};

const parseRepo = (fullName: string): RepoRef => {
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`Invalid repository full name: ${fullName}`);
  }
  return { owner, repo };
};

const buildGateMarker = (challengeId: string): string => `<!-- stake-to-contribute:gate:${challengeId} -->`;
const buildTimeoutMarker = (challengeId: string): string => `<!-- stake-to-contribute:timeout:${challengeId} -->`;

export class GitHubClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;

  constructor(options: GitHubClientOptions) {
    this.appId = options.appId;
    this.privateKeyPem = options.privateKeyPem;
  }

  async upsertGateComment(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    challengeId: string,
    commentMarkdown: string,
  ): Promise<void> {
    const marker = buildGateMarker(challengeId);
    await this.upsertIssueComment(installationId, repoFullName, prNumber, marker, commentMarkdown);
  }

  async upsertTimeoutComment(
    installationId: number,
    repoFullName: string,
    prNumber: number,
    challengeId: string,
    commentMarkdown: string,
  ): Promise<void> {
    const marker = buildTimeoutMarker(challengeId);
    await this.upsertIssueComment(installationId, repoFullName, prNumber, marker, commentMarkdown);
  }

  async closePullRequest(installationId: number, repoFullName: string, prNumber: number): Promise<void> {
    const token = await this.getInstallationToken(installationId);
    const { owner, repo } = parseRepo(repoFullName);
    const res = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: this.defaultHeaders(token),
      body: JSON.stringify({ state: "closed" }),
    });
    if (!res.ok) {
      throw new Error(`GitHub close pull request failed (${res.status})`);
    }
  }

  private async upsertIssueComment(
    installationId: number,
    repoFullName: string,
    issueNumber: number,
    marker: string,
    markdown: string,
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId);
    const { owner, repo } = parseRepo(repoFullName);
    const body = `${markdown.trim()}\n\n${marker}`;

    const existing = await this.findCommentByMarker(token, owner, repo, issueNumber, marker);
    if (existing) {
      const updateRes = await fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          headers: this.defaultHeaders(token),
          body: JSON.stringify({ body }),
        },
      );
      if (!updateRes.ok) {
        throw new Error(`GitHub update issue comment failed (${updateRes.status})`);
      }
      return;
    }

    const createRes = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
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
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
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

  private async getInstallationToken(installationId: number): Promise<string> {
    const jwt = signGitHubAppJwt(this.appId, this.privateKeyPem);
    const res = await fetchWithRetry(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub installation token request failed (${res.status})`);
    }
    const body = (await res.json()) as { token: string };
    if (!body.token) {
      throw new Error("GitHub installation token response missing token");
    }
    return body.token;
  }

  async getRepositoryFullNameById(installationId: number, repoId: number): Promise<string> {
    const token = await this.getInstallationToken(installationId);
    const res = await fetchWithRetry(`https://api.github.com/repositories/${repoId}`, {
      method: "GET",
      headers: this.defaultHeaders(token),
    });
    if (!res.ok) {
      throw new Error(`GitHub get repository by id failed (${res.status})`);
    }
    const body = (await res.json()) as { full_name?: string };
    if (!body.full_name) {
      throw new Error("GitHub repository response missing full_name");
    }
    return body.full_name;
  }

  private defaultHeaders(token: string): HeadersInit {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "stake-to-contribute-bot-worker",
    };
  }
}
