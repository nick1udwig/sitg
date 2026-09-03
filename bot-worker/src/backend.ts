import type {
  BotActionOutcome,
  BotActionResultResponse,
  BotActionsClaimResponse,
  InstallationSyncIngestResponse,
  NormalizedInstallationSyncEvent,
  NormalizedPrEvent,
  PullRequestIngestResponse,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { buildInternalEd25519Signature } from "./crypto.js";
import { fetchWithRetry } from "./retry.js";

type BackendClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  botKeyId: string;
  internalSigningKey: string;
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
  private readonly internalSigningKey: string;

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = options.serviceToken;
    this.botKeyId = options.botKeyId;
    this.internalSigningKey = options.internalSigningKey;
  }

  private applyInternalAuth(headers: Headers, message: string, body: string): void {
    const timestamp = Math.floor(Date.now() / 1000);
    const requestNonce = randomUUID();
    headers.set("x-sitg-key-id", this.botKeyId);
    headers.set("x-sitg-timestamp", String(timestamp));
    headers.set("x-sitg-nonce", requestNonce);
    headers.set(
      "x-sitg-signature",
      buildInternalEd25519Signature(this.internalSigningKey, timestamp, requestNonce, message, body),
    );
    withAuth(headers, this.serviceToken);
  }

  private postJson(path: string, message: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    return fetchWithRetry(`${this.baseUrl}${path}`, () => {
      const headers = new Headers({ "content-type": "application/json" });
      this.applyInternalAuth(headers, message, body);
      return { method: "POST", headers, body };
    });
  }

  async postPullRequestEvent(payload: NormalizedPrEvent): Promise<PullRequestIngestResponse> {
    const res = await this.postJson(
      "/internal/v2/github/events/pull-request",
      `github-event:pull_request:${payload.delivery_id}`,
      payload,
    );
    if (!res.ok) {
      throw new Error(`Backend /github/events/pull-request failed (${res.status})`);
    }
    return (await res.json()) as PullRequestIngestResponse;
  }

  async postInstallationSyncEvent(payload: NormalizedInstallationSyncEvent): Promise<InstallationSyncIngestResponse> {
    const res = await this.postJson(
      "/internal/v2/github/events/installation-sync",
      `github-event:installation-sync:${payload.delivery_id}`,
      payload,
    );
    if (!res.ok) {
      throw new Error(`Backend /github/events/installation-sync failed (${res.status})`);
    }
    return (await res.json()) as InstallationSyncIngestResponse;
  }

  async claimBotActions(workerId: string, limit: number): Promise<BotActionsClaimResponse> {
    const res = await this.postJson(
      "/internal/v2/bot-actions/claim",
      `bot-actions-claim:${workerId}`,
      { worker_id: workerId, limit },
    );
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
    const res = await this.postJson(
      `/internal/v2/bot-actions/${actionId}/result`,
      `bot-action-result:${actionId}:${workerId}:${outcome}`,
      {
        worker_id: workerId,
        outcome,
        failure_code: failureCode,
        failure_message: failureMessage,
      },
    );
    if (!res.ok) {
      throw new Error(`Backend /bot-actions/${actionId}/result failed (${res.status})`);
    }
    return (await res.json()) as BotActionResultResponse;
  }
}
