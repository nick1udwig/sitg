import type {
  BotActionOutcome,
  BotActionResultResponse,
  BotActionsClaimResponse,
  InstallationSyncIngestResponse,
  NormalizedInstallationSyncEvent,
  NormalizedPrEvent,
  PullRequestIngestResponse,
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
    headers.set("x-sitg-key-id", this.botKeyId);
    headers.set("x-sitg-timestamp", String(timestamp));
    headers.set("x-sitg-signature", buildInternalHmacSignature(this.internalHmacSecret, timestamp, message));
    withAuth(headers, this.serviceToken);
  }

  async postPullRequestEvent(payload: NormalizedPrEvent): Promise<PullRequestIngestResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `github-event:pull_request:${payload.delivery_id}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v2/github/events/pull-request`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Backend /github/events/pull-request failed (${res.status})`);
    }
    return (await res.json()) as PullRequestIngestResponse;
  }

  async postInstallationSyncEvent(payload: NormalizedInstallationSyncEvent): Promise<InstallationSyncIngestResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `github-event:installation-sync:${payload.delivery_id}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v2/github/events/installation-sync`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Backend /github/events/installation-sync failed (${res.status})`);
    }
    return (await res.json()) as InstallationSyncIngestResponse;
  }

  async claimBotActions(workerId: string, limit: number): Promise<BotActionsClaimResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `bot-actions-claim:${workerId}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v2/bot-actions/claim`, {
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
    outcome: BotActionOutcome,
    failureCode: string | null,
    failureMessage: string | null,
  ): Promise<BotActionResultResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    this.applyInternalAuth(headers, `bot-action-result:${actionId}:${workerId}:${outcome}`);
    const res = await fetchWithRetry(`${this.baseUrl}/internal/v2/bot-actions/${actionId}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        worker_id: workerId,
        outcome,
        failure_code: failureCode,
        failure_message: failureMessage,
      }),
    });
    if (!res.ok) {
      throw new Error(`Backend /bot-actions/${actionId}/result failed (${res.status})`);
    }
    return (await res.json()) as BotActionResultResponse;
  }
}
