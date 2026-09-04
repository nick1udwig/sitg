import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApiError, GitHubClient } from "../src/github.js";

const makeClient = (): GitHubClient => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new GitHubClient({
    appId: "12345",
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    apiBaseUrl: "https://api.github.test",
  });
};

test("GitHub client marks permission and validation failures as permanent", async () => {
  const originalFetch = globalThis.fetch;
  const client = makeClient();
  try {
    for (const status of [401, 403, 404, 422]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch;
      await assert.rejects(client.closePullRequest(123, "org/repo", 42), (error: unknown) => {
        assert.ok(error instanceof GitHubApiError);
        assert.equal(error.retryable, false);
        return true;
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub client preserves retryability for rate limits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 403,
      headers: { "retry-after": "60" },
    })) as typeof fetch;

  try {
    await assert.rejects(makeClient().closePullRequest(123, "org/repo", 42), (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub client single-flights and caches installation tokens", async () => {
  const originalFetch = globalThis.fetch;
  const client = makeClient();
  let tokenRequests = 0;
  let closeRequests = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      tokenRequests += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({
          token: "ghs_cached",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/repos/org/repo/pulls/42")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ghs_cached");
      closeRequests += 1;
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await Promise.all([
      client.closePullRequest(123, "org/repo", 42),
      client.closePullRequest(123, "org/repo", 42),
    ]);
    await client.closePullRequest(123, "org/repo", 42);

    assert.equal(tokenRequests, 1);
    assert.equal(closeRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub client finds and updates a marked comment after the first page", async () => {
  const originalFetch = globalThis.fetch;
  const client = makeClient();
  const requestedPages: number[] = [];
  let updatedComment = false;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_test" }), { status: 200 });
    }
    if (url.endsWith("/issues/42/comments?per_page=100&page=1")) {
      requestedPages.push(1);
      return new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `comment ${index + 1}` })),
        ),
        { status: 200 },
      );
    }
    if (url.endsWith("/issues/42/comments?per_page=100&page=2")) {
      requestedPages.push(2);
      return new Response(JSON.stringify([{ id: 101, body: "existing\n<!-- sitg:test -->" }]), {
        status: 200,
      });
    }
    if (url.endsWith("/issues/comments/101") && init?.method === "PATCH") {
      updatedComment = true;
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await client.upsertPrComment(123, "org/repo", 42, "sitg:test", "replacement");
    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(updatedComment, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub client lists installation repositories beyond one page", async () => {
  const originalFetch = globalThis.fetch;
  const client = makeClient();
  const requestedPages: number[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_test" }), { status: 200 });
    }
    if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
      requestedPages.push(1);
      return new Response(
        JSON.stringify({
          total_count: 101,
          repositories: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            full_name: `org/repo-${index + 1}`,
          })),
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/installation/repositories?per_page=100&page=2")) {
      requestedPages.push(2);
      return new Response(
        JSON.stringify({
          total_count: 101,
          repositories: [{ id: 101, full_name: "org/repo-101" }],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const repositories = await client.listInstallationRepositories(123);
    assert.equal(repositories.length, 101);
    assert.equal(repositories[100]?.full_name, "org/repo-101");
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
