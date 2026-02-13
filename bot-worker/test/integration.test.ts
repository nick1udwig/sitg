import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
};

const makeConfig = (stateFilePath: string): AppConfig => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    port: 0,
    githubWebhookSecret: "webhook-secret",
    backendBaseUrl: "http://backend.local",
    backendServiceToken: "backend-token",
    backendInternalHmacSecret: "internal-hmac-secret",
    githubAppId: "12345",
    githubAppPrivateKey: privateKeyPem,
    deadlineInternalToken: "deadline-secret",
    exemptCommentEnabled: false,
    stateFilePath,
  };
};

const signedWebhook = (payload: unknown, secret: string) => {
  const body = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
  return {
    body,
    signature: `sha256=${digest}`,
  };
};

const installFetchMock = (
  handler: (url: string, init: RequestInit) => Promise<Response>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
      return original(input, init);
    }
    return handler(url, init ?? {});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

test("webhook opened event posts gate comment based on backend REQUIRE_STAKE", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "stc-bot-it-"));
  const stateFile = join(tempDir, "state.json");
  const config = makeConfig(stateFile);
  const calls: FetchCall[] = [];

  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const bodyText = init.body ? String(init.body) : undefined;
    let body: unknown = undefined;
    if (bodyText) {
      body = JSON.parse(bodyText);
    }
    calls.push({ url, method, headers, body });

    if (url === "http://backend.local/internal/v1/pr-events") {
      assert.equal(headers.get("authorization"), "Bearer backend-token");
      const timestamp = headers.get("x-stc-timestamp");
      const signature = headers.get("x-stc-signature");
      assert.ok(timestamp);
      assert.ok(signature);
      const expected = `sha256=${createHmac("sha256", config.backendInternalHmacSecret)
        .update(`${timestamp}.00000000-0000-0000-0000-000000000123`)
        .digest("hex")}`;
      assert.equal(signature, expected);
      return new Response(
        JSON.stringify({
          decision: "REQUIRE_STAKE",
          challenge: {
            id: "11111111-1111-1111-1111-111111111111",
            gate_url: "https://app.example.com/g/token",
            deadline_at: new Date(Date.now() + 60_000).toISOString(),
            comment_markdown: "Please verify stake.",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/app/installations/123/access_tokens") {
      return new Response(JSON.stringify({ token: "ghs_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/org/repo/issues/42/comments?per_page=100") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/repos/org/repo/issues/42/comments" && method === "POST") {
      return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const payload = {
      action: "opened",
      installation: { id: 123 },
      repository: { id: 999, full_name: "org/repo" },
      pull_request: {
        number: 42,
        id: 1001,
        html_url: "https://github.com/org/repo/pull/42",
        draft: false,
        user: { id: 2001, login: "alice" },
        head: { sha: "abc123abc123abc123abc123abc123abc123abcd" },
      },
    };
    const webhook = signedWebhook(payload, config.githubWebhookSecret);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "00000000-0000-0000-0000-000000000123",
        "x-hub-signature-256": webhook.signature,
      },
      body: webhook.body,
    });
    assert.equal(res.status, 200);

    const createComment = calls.find((c) => c.url === "https://api.github.com/repos/org/repo/issues/42/comments");
    assert.ok(createComment);
    assert.match(String((createComment.body as { body: string }).body), /stake-to-contribute:gate:11111111/);
  } finally {
    server.close();
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("deadline run closes PR and posts timeout comment from backend CLOSE_PR action", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "stc-bot-it-"));
  const stateFile = join(tempDir, "state.json");
  const config = makeConfig(stateFile);
  const calls: FetchCall[] = [];

  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const bodyText = init.body ? String(init.body) : undefined;
    let body: unknown = undefined;
    if (bodyText) {
      body = JSON.parse(bodyText);
    }
    calls.push({ url, method, headers, body });

    if (url === "http://backend.local/internal/v1/pr-events") {
      return new Response(
        JSON.stringify({
          decision: "REQUIRE_STAKE",
          challenge: {
            id: "22222222-2222-2222-2222-222222222222",
            gate_url: "https://app.example.com/g/token2",
            deadline_at: new Date(Date.now() + 60_000).toISOString(),
            comment_markdown: "Please verify stake.",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "http://backend.local/internal/v1/challenges/22222222-2222-2222-2222-222222222222/deadline-check") {
      assert.equal(headers.get("authorization"), "Bearer backend-token");
      const timestamp = headers.get("x-stc-timestamp");
      const signature = headers.get("x-stc-signature");
      assert.ok(timestamp);
      assert.ok(signature);
      const expected = `sha256=${createHmac("sha256", config.backendInternalHmacSecret)
        .update(`${timestamp}.22222222-2222-2222-2222-222222222222`)
        .digest("hex")}`;
      assert.equal(signature, expected);
      return new Response(
        JSON.stringify({
          action: "CLOSE_PR",
          close: {
            github_repo_id: 999,
            github_pr_number: 42,
            comment_markdown: "Timeout close message",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/app/installations/123/access_tokens") {
      return new Response(JSON.stringify({ token: "ghs_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/org/repo/issues/42/comments?per_page=100") {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/repos/org/repo/issues/42/comments" && method === "POST") {
      return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/repos/org/repo/pulls/42" && method === "PATCH") {
      return new Response(JSON.stringify({ state: "closed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const payload = {
      action: "opened",
      installation: { id: 123 },
      repository: { id: 999, full_name: "org/repo" },
      pull_request: {
        number: 42,
        id: 1001,
        html_url: "https://github.com/org/repo/pull/42",
        draft: false,
        user: { id: 2001, login: "alice" },
        head: { sha: "abc123abc123abc123abc123abc123abc123abcd" },
      },
    };
    const webhook = signedWebhook(payload, config.githubWebhookSecret);
    const webhookRes = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "00000000-0000-0000-0000-000000000456",
        "x-hub-signature-256": webhook.signature,
      },
      body: webhook.body,
    });
    assert.equal(webhookRes.status, 200);

    const deadlineRes = await fetch(
      `http://127.0.0.1:${port}/internal/v1/deadlines/22222222-2222-2222-2222-222222222222/run`,
      {
        method: "POST",
        headers: { "x-internal-token": "deadline-secret" },
      },
    );
    assert.equal(deadlineRes.status, 200);

    assert.ok(calls.some((c) => c.url === "https://api.github.com/repos/org/repo/pulls/42" && c.method === "PATCH"));
    const timeoutComment = calls.find(
      (c) =>
        c.url === "https://api.github.com/repos/org/repo/issues/42/comments" &&
        String((c.body as { body: string }).body).includes("stake-to-contribute:timeout:22222222"),
    );
    assert.ok(timeoutComment);
  } finally {
    server.close();
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
