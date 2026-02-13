import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { signGitHubAppJwt, verifyGitHubWebhookSignature } from "../src/crypto.js";

test("verifyGitHubWebhookSignature validates a correct signature", () => {
  const secret = "my-secret";
  const payload = Buffer.from(JSON.stringify({ hello: "world" }));
  const digest = createHmac("sha256", secret).update(payload).digest("hex");

  const ok = verifyGitHubWebhookSignature(secret, payload, `sha256=${digest}`);
  assert.equal(ok, true);
});

test("verifyGitHubWebhookSignature rejects wrong signature", () => {
  const ok = verifyGitHubWebhookSignature("s1", Buffer.from("abc"), "sha256=1234");
  assert.equal(ok, false);
});

test("signGitHubAppJwt returns 3-part token", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const jwt = signGitHubAppJwt("12345", privateKeyPem);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.ok(parts[0].length > 0);
  assert.ok(parts[1].length > 0);
  assert.ok(parts[2].length > 0);
});
