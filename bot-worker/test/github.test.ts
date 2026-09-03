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
