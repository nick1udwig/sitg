#!/usr/bin/env node

import { createServer } from "node:http";
import { URL } from "node:url";

const port = Number.parseInt(process.env.MOCK_GITHUB_PORT ?? process.argv[2] ?? "9010", 10);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid mock GitHub port: ${String(port)}`);
}
const host = process.env.MOCK_GITHUB_HOST ?? "127.0.0.1";

const parseRepoMap = () => {
  const raw = process.env.MOCK_GITHUB_REPO_MAP ?? "999=owner/repo";
  const map = new Map();
  for (const item of raw.split(",")) {
    const [idRaw, fullName] = item.split("=", 2).map((s) => s.trim());
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id) || id <= 0 || !fullName || !fullName.includes("/")) {
      continue;
    }
    map.set(id, fullName);
  }
  return map;
};

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};

const json = (res, code, body) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const commentsByThread = new Map(); // key: owner/repo#issue => [{id, body}]
const commentsById = new Map(); // key: id => {threadKey, idx}
const pulls = new Map(); // key: owner/repo#pr => {state}
const reposById = parseRepoMap();
let nextCommentId = 1;

const getThreadKey = (owner, repo, issue) => `${owner}/${repo}#${issue}`;

const getComments = (owner, repo, issue) => {
  const key = getThreadKey(owner, repo, issue);
  if (!commentsByThread.has(key)) {
    commentsByThread.set(key, []);
  }
  return commentsByThread.get(key);
};

const setRepoIdByName = (owner, repo, explicitId) => {
  const fullName = `${owner}/${repo}`;
  if (Number.isFinite(explicitId) && explicitId > 0) {
    reposById.set(explicitId, fullName);
    return;
  }

  for (const [id, name] of reposById.entries()) {
    if (name === fullName) {
      return;
    }
  }
};

const statePayload = () => ({
  repos: Array.from(reposById.entries()).map(([id, full_name]) => ({ id, full_name })),
  pulls: Array.from(pulls.entries()).map(([key, value]) => ({ key, ...value })),
  comments: Array.from(commentsByThread.entries()).map(([thread, list]) => ({
    thread,
    comments: list.map((c) => ({ id: c.id, body: c.body })),
  })),
});

const handleHealth = async (_req, res, method, pathname) => {
  if (method !== "GET" || pathname !== "/healthz") {
    return false;
  }
  json(res, 200, { status: "ok" });
  return true;
};

const handleState = async (_req, res, method, pathname) => {
  if (method !== "GET" || pathname !== "/_state") {
    return false;
  }
  json(res, 200, statePayload());
  return true;
};

const handleInstallationToken = async (_req, res, method, pathname) => {
  const match = pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  if (method !== "POST" || !match) {
    return false;
  }
  const installationId = Number.parseInt(match[1], 10);
  json(res, 201, { token: `mock-installation-${installationId}` });
  return true;
};

const handleRepositoryLookup = async (_req, res, method, pathname) => {
  const match = pathname.match(/^\/repositories\/(\d+)$/);
  if (method !== "GET" || !match) {
    return false;
  }
  const repoId = Number.parseInt(match[1], 10);
  const fullName = reposById.get(repoId);
  if (!fullName) {
    json(res, 404, { message: "Not Found" });
    return true;
  }
  json(res, 200, { id: repoId, full_name: fullName });
  return true;
};

const handlePullUpdate = async (req, res, method, pathname) => {
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (method !== "PATCH" || !match) {
    return false;
  }
  const owner = match[1];
  const repo = match[2];
  const prNumber = Number.parseInt(match[3], 10);
  const body = await readJson(req);
  const desiredState = String(body.state ?? "open");
  const key = `${owner}/${repo}#${prNumber}`;
  pulls.set(key, { state: desiredState });
  setRepoIdByName(owner, repo);
  json(res, 200, { number: prNumber, state: desiredState });
  return true;
};

const handleIssueComments = async (req, res, method, pathname) => {
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
  if (!match || (method !== "GET" && method !== "POST")) {
    return false;
  }
  const owner = match[1];
  const repo = match[2];
  const issue = Number.parseInt(match[3], 10);
  const comments = getComments(owner, repo, issue);
  if (method === "GET") {
    json(res, 200, comments);
    return true;
  }

  const payload = await readJson(req);
  const body = String(payload.body ?? "");
  const record = { id: nextCommentId++, body };
  commentsById.set(record.id, {
    threadKey: getThreadKey(owner, repo, issue),
    idx: comments.length,
  });
  comments.push(record);
  setRepoIdByName(owner, repo);
  json(res, 201, record);
  return true;
};

const handleCommentUpdate = async (req, res, method, pathname) => {
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/);
  if (method !== "PATCH" || !match) {
    return false;
  }
  const owner = match[1];
  const repo = match[2];
  const commentId = Number.parseInt(match[3], 10);
  const payload = await readJson(req);
  const body = String(payload.body ?? "");
  const loc = commentsById.get(commentId);
  if (!loc) {
    json(res, 404, { message: "Not Found" });
    return true;
  }

  const list = commentsByThread.get(loc.threadKey);
  if (!list || !list[loc.idx]) {
    json(res, 404, { message: "Not Found" });
    return true;
  }
  list[loc.idx] = { id: commentId, body };
  setRepoIdByName(owner, repo);
  json(res, 200, list[loc.idx]);
  return true;
};

const routeHandlers = [
  handleHealth,
  handleState,
  handleInstallationToken,
  handleRepositoryLookup,
  handlePullUpdate,
  handleIssueComments,
  handleCommentUpdate,
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    for (const handleRoute of routeHandlers) {
      if (await handleRoute(req, res, method, pathname)) {
        return;
      }
    }

    return json(res, 404, { message: "Not Found" });
  } catch (error) {
    return json(res, 500, {
      message: "Internal Server Error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-github listening on http://${host}:${port}`);
});
