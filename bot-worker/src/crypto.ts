import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";

const toBase64Url = (raw: string | Buffer): string =>
  Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const signGitHubAppJwt = (appId: string, privateKeyPem: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
};

export const verifyGitHubWebhookSignature = (
  secret: string,
  payloadRaw: Buffer,
  signatureHeader: string | undefined,
): boolean => {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payloadRaw).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
};

export const buildInternalHmacSignature = (secret: string, unixTimestampSeconds: number, message: string): string => {
  const derivedKey = createHash("sha256").update(secret).digest();
  const payload = `${unixTimestampSeconds}.${message}`;
  const digest = createHmac("sha256", derivedKey).update(payload).digest("hex");
  return `sha256=${digest}`;
};
