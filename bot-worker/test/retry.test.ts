import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/retry.js";

test("fetchWithRetry aborts a hung request at the per-attempt timeout", async () => {
  const originalFetch = globalThis.fetch;
  const keepEventLoopAlive = setTimeout(() => {}, 1_000);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("expected timeout signal"));
        return;
      }
      const rejectWithReason = (): void => reject(signal.reason);
      if (signal.aborted) {
        rejectWithReason();
      } else {
        signal.addEventListener("abort", rejectWithReason, { once: true });
      }
    })) as typeof fetch;

  try {
    await assert.rejects(fetchWithRetry("https://example.test/hangs", {}, 1, 0, 20), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "TimeoutError");
      return true;
    });
  } finally {
    clearTimeout(keepEventLoopAlive);
    globalThis.fetch = originalFetch;
  }
});
