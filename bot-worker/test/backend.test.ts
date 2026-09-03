import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { BackendClient } from "../src/backend.js";
import { buildInternalSigningPayload } from "../src/crypto.js";

test("backend retries use fresh nonces and signatures bound to the body", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const client = new BackendClient({
    baseUrl: "https://backend.test",
    botKeyId: "test-key",
    internalSigningKey: privateKeyPem,
  });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: string }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ headers, body });
    if (requests.length === 1) {
      return new Response("{}", { status: 500 });
    }
    return new Response(JSON.stringify({ actions: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await client.claimBotActions("worker-1", 25);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.notEqual(requests[0]?.headers.get("x-sitg-nonce"), requests[1]?.headers.get("x-sitg-nonce"));
  assert.notEqual(requests[0]?.headers.get("x-sitg-signature"), requests[1]?.headers.get("x-sitg-signature"));

  for (const request of requests) {
    const timestamp = Number.parseInt(request.headers.get("x-sitg-timestamp") ?? "", 10);
    const nonce = request.headers.get("x-sitg-nonce") ?? "";
    const signature = request.headers.get("x-sitg-signature")?.replace(/^ed25519=/, "") ?? "";
    const payload = buildInternalSigningPayload(timestamp, nonce, "bot-actions-claim:worker-1", request.body);
    assert.equal(verify(null, payload, publicKey, Buffer.from(signature, "hex")), true);
  }
});
