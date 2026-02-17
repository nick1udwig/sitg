import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { buildInternalHmacSignature } from "../src/crypto.js";

type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
};

const makeConfig = (): AppConfig => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    port: 0,
    githubWebhookSecret: "webhook-secret",
    githubApiBaseUrl: "https://api.github.com",
    backendBaseUrl: "http://backend.local",
    backendServiceToken: "backend-token",
    backendBotKeyId: "bck_test_123",
    backendInternalHmacSecret: "internal-hmac-secret",
    githubAppId: "12345",
    githubAppPrivateKey: privateKeyPem,
    workerId: "bot-worker-1",
    outboxPollingEnabled: false,
    outboxPollIntervalMs: 5_000,
    outboxClaimLimit: 25,
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
};

test("pull_request webhook forwards to backend v2 with canonical signature message", async () => {
  const config = makeConfig();
  const calls: FetchCall[] = [];

  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers, body });

    if (url === "http://backend.local/internal/v2/github/events/pull-request") {
      assert.equal(headers.get("authorization"), "Bearer backend-token");
      assert.equal(headers.get("x-sitg-key-id"), "bck_test_123");
      const timestamp = headers.get("x-sitg-timestamp");
      const signature = headers.get("x-sitg-signature");
      assert.ok(timestamp);
      assert.ok(signature);
      const expected = buildInternalHmacSignature(
        config.backendInternalHmacSecret,
        Number.parseInt(timestamp, 10),
        "github-event:pull_request:00000000-0000-0000-0000-000000000123",
      );
      assert.equal(signature, expected);
      return new Response(
        JSON.stringify({ ingest_status: "ACCEPTED", challenge_id: null, enqueued_actions: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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
    assert.ok(calls.some((c) => c.url === "http://backend.local/internal/v2/github/events/pull-request"));

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metrics = await metricsRes.text();
    assert.match(metrics, /sitg_bot_webhook_pull_request_forwarded_total 1/);
    assert.match(metrics, /sitg_bot_webhook_ingest_accepted_total 1/);
  } finally {
    server.close();
    restoreFetch();
  }
});

test("installation_repositories webhook forwards to backend v2", async () => {
  const config = makeConfig();

  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);

    if (url === "http://backend.local/internal/v2/github/events/installation-sync") {
      assert.equal(headers.get("x-sitg-key-id"), "bck_test_123");
      const bodyText = String(init.body ?? "");
      const body = JSON.parse(bodyText) as { event_name: string; action: string; installation: { id: number } };
      assert.equal(body.event_name, "installation_repositories");
      assert.equal(body.action, "added");
      assert.equal(body.installation.id, 333);
      return new Response(
        JSON.stringify({ ingest_status: "ACCEPTED", updated_installation_id: 333, updated_repositories: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const payload = {
      action: "added",
      installation: {
        id: 333,
        account: {
          login: "org",
          type: "Organization",
        },
      },
      repositories_added: [{ id: 999, full_name: "org/repo" }],
      repositories_removed: [],
    };
    const webhook = signedWebhook(payload, config.githubWebhookSecret);

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation_repositories",
        "x-github-delivery": "00000000-0000-0000-0000-000000000444",
        "x-hub-signature-256": webhook.signature,
      },
      body: webhook.body,
    });

    assert.equal(res.status, 200);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metrics = await metricsRes.text();
    assert.match(metrics, /sitg_bot_webhook_installation_sync_forwarded_total 1/);
    assert.match(metrics, /sitg_bot_webhook_ingest_accepted_total 1/);
  } finally {
    server.close();
    restoreFetch();
  }
});

test("installation created backfills repositories from GitHub when payload has none", async () => {
  const config = makeConfig();
  const calls: FetchCall[] = [];

  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers, body });

    if (url === "https://api.github.com/app/installations/555/access_tokens" && method === "POST") {
      return new Response(JSON.stringify({ token: "ghs_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://api.github.com/installation/repositories?per_page=100&page=1" && method === "GET") {
      return new Response(
        JSON.stringify({
          total_count: 1,
          repositories: [{ id: 999, full_name: "org/repo" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === "http://backend.local/internal/v2/github/events/installation-sync" && method === "POST") {
      const payload = body as {
        event_name: string;
        action: string;
        repositories: Array<{ id: number; full_name: string }>;
      };
      assert.equal(payload.event_name, "installation");
      assert.equal(payload.action, "created");
      assert.equal(payload.repositories.length, 1);
      assert.equal(payload.repositories[0]?.full_name, "org/repo");
      return new Response(
        JSON.stringify({ ingest_status: "ACCEPTED", updated_installation_id: 555, updated_repositories: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const payload = {
      action: "created",
      installation: {
        id: 555,
        account: {
          login: "org",
          type: "Organization",
        },
      },
      repositories: [],
    };
    const webhook = signedWebhook(payload, config.githubWebhookSecret);

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "00000000-0000-0000-0000-000000000999",
        "x-hub-signature-256": webhook.signature,
      },
      body: webhook.body,
    });

    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.url === "https://api.github.com/installation/repositories?per_page=100&page=1"));
  } finally {
    server.close();
    restoreFetch();
  }
});

test("outbox polling executes UPSERT_PR_COMMENT and acks SUCCEEDED", async () => {
  const config: AppConfig = {
    ...makeConfig(),
    outboxPollingEnabled: true,
    outboxPollIntervalMs: 2_000,
    outboxClaimLimit: 25,
  };
  const calls: FetchCall[] = [];

  let claimedOnce = false;
  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers, body });

    if (url === "http://backend.local/internal/v2/bot-actions/claim") {
      if (!claimedOnce) {
        claimedOnce = true;
        return new Response(
          JSON.stringify({
            actions: [
              {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                action_type: "UPSERT_PR_COMMENT",
                installation_id: 123,
                github_repo_id: 999,
                repo_full_name: "org/repo",
                github_pr_number: 42,
                challenge_id: null,
                payload: {
                  comment_markdown: "Outbox gate comment",
                  comment_marker: "sitg:gate:aaaaaaaa",
                  reason: "REQUIRE_STAKE",
                },
                attempts: 0,
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
    if (url === "http://backend.local/internal/v2/bot-actions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/result") {
      const typedBody = body as { outcome: string };
      assert.equal(typedBody.outcome, "SUCCEEDED");
      return new Response(JSON.stringify({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", status: "DONE" }), {
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
    await waitFor(
      () =>
        calls.some((c) => c.url === "http://backend.local/internal/v2/bot-actions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/result"),
      2000,
    );

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metrics = await metricsRes.text();
    assert.match(metrics, /sitg_bot_outbox_actions_success_total 1/);
  } finally {
    server.close();
    restoreFetch();
  }
});

test("outbox polling sends FAILED for invalid action payload", async () => {
  const config: AppConfig = {
    ...makeConfig(),
    outboxPollingEnabled: true,
    outboxPollIntervalMs: 2_000,
  };
  const calls: FetchCall[] = [];

  let claimedOnce = false;
  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers: new Headers(init.headers), body });

    if (url === "http://backend.local/internal/v2/bot-actions/claim") {
      if (!claimedOnce) {
        claimedOnce = true;
        return new Response(
          JSON.stringify({
            actions: [
              {
                id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                action_type: "UPSERT_PR_COMMENT",
                installation_id: 123,
                github_repo_id: 999,
                repo_full_name: "org/repo",
                github_pr_number: 42,
                challenge_id: null,
                payload: {
                  comment_markdown: "",
                  comment_marker: "",
                },
                attempts: 0,
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "http://backend.local/internal/v2/bot-actions/cccccccc-cccc-cccc-cccc-cccccccccccc/result") {
      const typedBody = body as { outcome: string; failure_code: string };
      assert.equal(typedBody.outcome, "FAILED");
      assert.equal(typedBody.failure_code, "INVALID_ACTION_PAYLOAD");
      return new Response(JSON.stringify({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    await waitFor(
      () => calls.some((c) => c.url === "http://backend.local/internal/v2/bot-actions/cccccccc-cccc-cccc-cccc-cccccccccccc/result"),
      2000,
    );
  } finally {
    server.close();
    restoreFetch();
  }
});

test("outbox polling sends RETRYABLE_FAILURE for GitHub execution errors", async () => {
  const config: AppConfig = {
    ...makeConfig(),
    outboxPollingEnabled: true,
    outboxPollIntervalMs: 2_000,
  };
  const calls: FetchCall[] = [];

  let claimedOnce = false;
  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers: new Headers(init.headers), body });

    if (url === "http://backend.local/internal/v2/bot-actions/claim") {
      if (!claimedOnce) {
        claimedOnce = true;
        return new Response(
          JSON.stringify({
            actions: [
              {
                id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
                action_type: "UPSERT_PR_COMMENT",
                installation_id: 123,
                github_repo_id: 999,
                repo_full_name: "org/repo",
                github_pr_number: 42,
                challenge_id: null,
                payload: {
                  comment_markdown: "hello",
                  comment_marker: "sitg:gate:dddddddd",
                },
                attempts: 0,
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://api.github.com/app/installations/123/access_tokens") {
      return new Response(JSON.stringify({ message: "server unavailable" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "http://backend.local/internal/v2/bot-actions/dddddddd-dddd-dddd-dddd-dddddddddddd/result") {
      const typedBody = body as { outcome: string; failure_code: string };
      assert.equal(typedBody.outcome, "RETRYABLE_FAILURE");
      assert.equal(typedBody.failure_code, "EXECUTION_ERROR");
      return new Response(JSON.stringify({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", status: "PENDING" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    await waitFor(
      () => calls.some((c) => c.url === "http://backend.local/internal/v2/bot-actions/dddddddd-dddd-dddd-dddd-dddddddddddd/result"),
      2000,
    );
  } finally {
    server.close();
    restoreFetch();
  }
});

test("outbox polling recovers stale installation id for CLOSE_PR_WITH_COMMENT", async () => {
  const config: AppConfig = {
    ...makeConfig(),
    outboxPollingEnabled: true,
    outboxPollIntervalMs: 250,
  };
  const calls: FetchCall[] = [];

  let claimedOnce = false;
  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers: new Headers(init.headers), body });

    if (url === "http://backend.local/internal/v2/bot-actions/claim") {
      if (!claimedOnce) {
        claimedOnce = true;
        return new Response(
          JSON.stringify({
            actions: [
              {
                id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
                action_type: "CLOSE_PR_WITH_COMMENT",
                installation_id: 123,
                github_repo_id: 999,
                repo_full_name: "org/repo",
                github_pr_number: 42,
                challenge_id: "11111111-2222-3333-4444-555555555555",
                payload: {
                  comment_markdown: "timeout",
                  comment_marker: "sitg:timeout:eeeeeeee",
                },
                attempts: 0,
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://api.github.com/app/installations/123/access_tokens") {
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/org/repo/installation") {
      return new Response(JSON.stringify({ id: 777 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/app/installations/777/access_tokens") {
      return new Response(JSON.stringify({ token: "ghs_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/org/repo/pulls/42" && method === "PATCH") {
      return new Response(JSON.stringify({ number: 42, state: "closed" }), {
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
    if (url === "http://backend.local/internal/v2/bot-actions/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/result") {
      const typedBody = body as { outcome: string };
      assert.equal(typedBody.outcome, "SUCCEEDED");
      return new Response(JSON.stringify({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", status: "DONE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    await waitFor(
      () => calls.some((c) => c.url === "http://backend.local/internal/v2/bot-actions/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/result"),
      5000,
    );
  } finally {
    server.close();
    restoreFetch();
  }
});

test("outbox polling sends FAILED when installation cannot be resolved", async () => {
  const config: AppConfig = {
    ...makeConfig(),
    outboxPollingEnabled: true,
    outboxPollIntervalMs: 250,
  };
  const calls: FetchCall[] = [];

  let claimedOnce = false;
  const restoreFetch = installFetchMock(async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const bodyText = init.body ? String(init.body) : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    calls.push({ url, method, headers: new Headers(init.headers), body });

    if (url === "http://backend.local/internal/v2/bot-actions/claim") {
      if (!claimedOnce) {
        claimedOnce = true;
        return new Response(
          JSON.stringify({
            actions: [
              {
                id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
                action_type: "UPSERT_PR_COMMENT",
                installation_id: 123,
                github_repo_id: 999,
                repo_full_name: "org/repo",
                github_pr_number: 42,
                challenge_id: null,
                payload: {
                  comment_markdown: "hello",
                  comment_marker: "sitg:gate:ffffffff",
                },
                attempts: 0,
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://api.github.com/app/installations/123/access_tokens") {
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://api.github.com/repos/org/repo/installation") {
      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "http://backend.local/internal/v2/bot-actions/ffffffff-ffff-ffff-ffff-ffffffffffff/result") {
      const typedBody = body as { outcome: string; failure_code: string };
      assert.equal(typedBody.outcome, "FAILED");
      assert.equal(typedBody.failure_code, "INSTALLATION_NOT_FOUND");
      return new Response(JSON.stringify({ id: "ffffffff-ffff-ffff-ffff-ffffffffffff", status: "FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const server = createAppServer(config);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    await waitFor(
      () => calls.some((c) => c.url === "http://backend.local/internal/v2/bot-actions/ffffffff-ffff-ffff-ffff-ffffffffffff/result"),
      5000,
    );
  } finally {
    server.close();
    restoreFetch();
  }
});
