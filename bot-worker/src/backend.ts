import type { DeadlineCheckResponse, NormalizedPrEvent, PrEventDecisionResponse } from "./types.js";
import { buildInternalHmacSignature } from "./crypto.js";
import { fetchWithRetry } from "./retry.js";

type BackendClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  internalHmacSecret: string;
};

const withAuth = (headers: Headers, serviceToken?: string): void => {
  if (serviceToken) {
    headers.set("authorization", `Bearer ${serviceToken}`);
  }
};

export class BackendClient {
  private readonly baseUrl: string;
  private readonly serviceToken?: string;
  private readonly internalHmacSecret: string;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = options.serviceToken;
    this.internalHmacSecret = options.internalHmacSecret;
  }

  private applyInternalAuth(headers: Headers, message: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    headers.set("x-stc-timestamp", String(timestamp));
    headers.set("x-stc-signature", buildInternalHmacSignature(this.internalHmacSecret, timestamp, message));
    withAuth(headers, this.serviceToken);
  }

  async postPrEvent(payload: NormalizedPrEvent): Promise<PrEventDecisionResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, payload.delivery_id);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v1/pr-events`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Backend /pr-events failed (${res.status})`);
    }
    return (await res.json()) as PrEventDecisionResponse;
  }

  async deadlineCheck(challengeId: string): Promise<DeadlineCheckResponse> {
    const headers = new Headers();
    this.applyInternalAuth(headers, challengeId);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v1/challenges/${challengeId}/deadline-check`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      throw new Error(`Backend /deadline-check failed (${res.status})`);
    }
    return (await res.json()) as DeadlineCheckResponse;
  }
}
