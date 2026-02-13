import type {
  BotActionResultResponse,
  BotActionsClaimResponse,
  DeadlineCheckResponse,
  NormalizedPrEvent,
  PrEventDecisionResponse,
} from "./types.js";
import { buildInternalHmacSignature } from "./crypto.js";
import { fetchWithRetry } from "./retry.js";

type BackendClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  botKeyId: string;
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
  private readonly botKeyId: string;
  private readonly internalHmacSecret: string;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = options.serviceToken;
    this.botKeyId = options.botKeyId;
    this.internalHmacSecret = options.internalHmacSecret;
  }

  private applyInternalAuth(headers: Headers, message: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    headers.set("x-stc-key-id", this.botKeyId);
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

  async claimBotActions(workerId: string, limit: number): Promise<BotActionsClaimResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `bot-actions-claim:${workerId}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v1/bot-actions/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worker_id: workerId, limit }),
    });
    if (!res.ok) {
      throw new Error(`Backend /bot-actions/claim failed (${res.status})`);
    }
    return (await res.json()) as BotActionsClaimResponse;
  }

  async postBotActionResult(
    actionId: string,
    workerId: string,
    success: boolean,
    failureReason: string | null,
    retryable: boolean | null,
  ): Promise<BotActionResultResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `bot-action-result:${actionId}:${workerId}:${success}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v1/bot-actions/${actionId}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        worker_id: workerId,
        success,
        failure_reason: failureReason,
        retryable,
      }),
    });
    if (!res.ok) {
      throw new Error(`Backend /bot-actions/${actionId}/result failed (${res.status})`);
    }
    return (await res.json()) as BotActionResultResponse;
  }
}
