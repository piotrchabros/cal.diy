import type { AgentBrowserAction, AgentBrowserPageState } from "@calcom/lib/agentBrowser/contract";
import {
  AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS,
  agentBrowserBotIdSchema,
  agentBrowserErrorResponseSchema,
  agentBrowserPageStateSchema,
  buildAgentBrowserAuthorization,
  signAgentBrowserViewerToken,
} from "@calcom/lib/agentBrowser/contract";
import type { ErrorWithCode } from "@calcom/lib/errors";
import { createAgentBrowserGatewayError, type IAgentBrowserGateway } from "./IAgentBrowserGateway";

// agent-browser caps each action at 15 s (20 s for navigation); the margin covers the settle and snapshot.
const DEFAULT_TIMEOUT_MS = 25_000;

type RawResponse = { status: number; text: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class HttpAgentBrowserGateway implements IAgentBrowserGateway {
  private readonly internalUrl: string;
  private readonly publicUrl: string;
  private readonly secret: string;
  private readonly viewerTokenTtlSeconds: number;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(deps: {
    internalUrl: string;
    publicUrl: string;
    secret: string;
    viewerTokenTtlSeconds: number;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.internalUrl = deps.internalUrl.replace(/\/+$/, "");
    this.publicUrl = deps.publicUrl.replace(/\/+$/, "");
    this.secret = deps.secret;
    // The contract refuses to sign longer tokens, and a meeting longer than the cap is better served by a
    // token that expires than by a share that never starts.
    this.viewerTokenTtlSeconds = Math.min(
      Math.max(1, Math.floor(deps.viewerTokenTtlSeconds)),
      AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS
    );
    this.fetchFn = deps.fetchFn;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async perform(botId: string, action: AgentBrowserAction): Promise<AgentBrowserPageState> {
    this.assertBotId(botId);
    const template = "POST /v1/sessions/{botId}/actions";
    const response = await this.send(
      "POST",
      `/v1/sessions/${encodeURIComponent(botId)}/actions`,
      template,
      action
    );
    if (response.status < 200 || response.status >= 300) throw this.responseError(response, template);

    const parsed = agentBrowserPageStateSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
      throw createAgentBrowserGatewayError(
        "UNAVAILABLE",
        `Agent browser ${template} returned an invalid page state (HTTP ${response.status})`
      );
    }
    return parsed.data;
  }

  async closeSession(botId: string): Promise<void> {
    this.assertBotId(botId);
    const template = "DELETE /v1/sessions/{botId}";
    const response = await this.send("DELETE", `/v1/sessions/${encodeURIComponent(botId)}`, template);
    if (response.status >= 200 && response.status < 300) return;
    throw this.responseError(response, template);
  }

  buildViewerUrl(botId: string, now: Date): string {
    this.assertBotId(botId);
    const token = signAgentBrowserViewerToken({
      secret: this.secret,
      botId,
      issuedAt: now,
      ttlSeconds: this.viewerTokenTtlSeconds,
    });
    return `${this.publicUrl}/view?token=${encodeURIComponent(token)}`;
  }

  private assertBotId(botId: string): void {
    if (agentBrowserBotIdSchema.safeParse(botId).success) return;
    throw createAgentBrowserGatewayError("INVALID_INPUT", "Agent browser request rejected: invalid botId");
  }

  private async send(
    method: "POST" | "DELETE",
    path: string,
    template: string,
    body?: unknown
  ): Promise<RawResponse> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    // AbortController + setTimeout rather than AbortSignal.timeout so fake timers can drive it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetchFn(`${this.internalUrl}${path}`, {
        method,
        headers: {
          Authorization: buildAgentBrowserAuthorization(this.secret),
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      // The body is read inside the timeout window so a stalled stream is also aborted.
      const text = await response.text();
      return { status: response.status, text };
    } catch {
      throw createAgentBrowserGatewayError(
        "UNAVAILABLE",
        timedOut
          ? `Agent browser ${template} timed out after ${this.timeoutMs}ms`
          : `Agent browser ${template} failed: network error`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private responseError(response: RawResponse, template: string): ErrorWithCode {
    const parsed = agentBrowserErrorResponseSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
      return createAgentBrowserGatewayError(
        "UNAVAILABLE",
        `Agent browser ${template} failed with HTTP ${response.status}`
      );
    }
    return createAgentBrowserGatewayError(
      parsed.data.error,
      `Agent browser ${template} failed with ${parsed.data.error} (HTTP ${response.status}): ${parsed.data.message}`
    );
  }
}
