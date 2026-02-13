import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { buildDeliveryDedupKey, parsePullRequestEvent } from "../src/webhook.js";

const makeSignedEvent = (payload: object, secret = "secret") => {
  const raw = Buffer.from(JSON.stringify(payload));
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const headers: IncomingHttpHeaders = {
    "x-hub-signature-256": `sha256=${digest}`,
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
  };
  return { raw, headers, secret };
};

test("parsePullRequestEvent returns normalized event for supported action", () => {
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
  const { raw, headers, secret } = makeSignedEvent(payload);
  const event = parsePullRequestEvent(headers, raw, secret, "2026-02-13T00:00:00.000Z");

  assert.ok(event);
  assert.equal(event?.action, "opened");
  assert.equal(event?.repository.full_name, "org/repo");
  assert.equal(event?.pull_request.number, 42);
  assert.equal(event?.event_time, "2026-02-13T00:00:00.000Z");
});

test("parsePullRequestEvent ignores unsupported action", () => {
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
  const { raw, headers, secret } = makeSignedEvent(payload);
  assert.equal(parsePullRequestEvent(headers, raw, secret), null);
});

test("parsePullRequestEvent rejects invalid signature", () => {
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
    "x-github-delivery": "delivery-1",
  };
  assert.equal(parsePullRequestEvent(headers, raw, "secret"), null);
});

test("buildDeliveryDedupKey uses delivery/action/repo/pr", () => {
  const dedup = buildDeliveryDedupKey({
    delivery_id: "d",
    installation_id: 1,
    action: "reopened",
    repository: { id: 22, full_name: "org/repo" },
    pull_request: {
      number: 11,
      id: 99,
      html_url: "x",
      user: { id: 5, login: "u" },
      head_sha: "sha",
      is_draft: false,
    },
    event_time: "t",
  });
  assert.equal(dedup, "d:reopened:22:11");
});
