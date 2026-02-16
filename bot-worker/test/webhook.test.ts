import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { parseGitHubWebhookEvent } from "../src/webhook.js";

const makeSignedEvent = (event: string, deliveryId: string, payload: object, secret = "secret") => {
  const raw = Buffer.from(JSON.stringify(payload));
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const headers: IncomingHttpHeaders = {
    "x-hub-signature-256": `sha256=${digest}`,
    "x-github-event": event,
    "x-github-delivery": deliveryId,
  };
  return { raw, headers, secret };
};

test("parseGitHubWebhookEvent returns normalized pull_request event", () => {
  const payload = {
    action: "opened",
    installation: { id: 123 },
    repository: { id: 456, full_name: "org/repo" },
    pull_request: {
      number: 42,
      id: 777,
      html_url: "https://github.com/org/repo/pull/42",
      draft: false,
      user: { id: 999, login: "alice" },
      head: { sha: "abc123" },
    },
  };
  const { raw, headers, secret } = makeSignedEvent("pull_request", "delivery-1", payload);
  const parsed = parseGitHubWebhookEvent(headers, raw, secret, "2026-02-13T00:00:00.000Z");

  assert.ok(parsed);
  assert.equal(parsed?.event_name, "pull_request");
  if (!parsed || parsed.event_name !== "pull_request") {
    throw new Error("expected pull_request event");
  }
  assert.equal(parsed.payload.action, "opened");
  assert.equal(parsed.payload.repository.full_name, "org/repo");
  assert.equal(parsed.payload.pull_request.number, 42);
  assert.equal(parsed.payload.event_time, "2026-02-13T00:00:00.000Z");
});

test("parseGitHubWebhookEvent returns normalized installation_repositories event", () => {
  const payload = {
    action: "added",
    installation: {
      id: 123,
      account: {
        login: "org",
        type: "Organization",
      },
    },
    repositories_added: [{ id: 456, full_name: "org/repo" }],
    repositories_removed: [],
  };

  const { raw, headers, secret } = makeSignedEvent("installation_repositories", "delivery-2", payload);
  const parsed = parseGitHubWebhookEvent(headers, raw, secret, "2026-02-13T00:00:00.000Z");

  assert.ok(parsed);
  assert.equal(parsed?.event_name, "installation_repositories");
  if (!parsed || parsed.event_name !== "installation_repositories") {
    throw new Error("expected installation_repositories event");
  }

  assert.equal(parsed.payload.action, "added");
  assert.equal(parsed.payload.installation.id, 123);
  assert.equal(parsed.payload.installation.account_login, "org");
  assert.equal(parsed.payload.repositories_added.length, 1);
  assert.equal(parsed.payload.repositories_added[0]?.full_name, "org/repo");
});

test("parseGitHubWebhookEvent ignores unsupported action", () => {
  const payload = {
    action: "closed",
    installation: { id: 1 },
    repository: { id: 2, full_name: "org/repo" },
    pull_request: {
      number: 3,
      id: 4,
      html_url: "https://github.com/org/repo/pull/3",
      user: { id: 5, login: "bob" },
      head: { sha: "def456" },
    },
  };
  const { raw, headers, secret } = makeSignedEvent("pull_request", "delivery-3", payload);
  assert.equal(parseGitHubWebhookEvent(headers, raw, secret), null);
});

test("parseGitHubWebhookEvent rejects invalid signature", () => {
  const payload = {
    action: "opened",
    installation: { id: 1 },
    repository: { id: 2, full_name: "org/repo" },
    pull_request: {
      number: 3,
      id: 4,
      html_url: "https://github.com/org/repo/pull/3",
      user: { id: 5, login: "bob" },
      head: { sha: "def456" },
    },
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const headers: IncomingHttpHeaders = {
    "x-hub-signature-256": "sha256=00",
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-4",
  };
  assert.equal(parseGitHubWebhookEvent(headers, raw, "secret"), null);
});
