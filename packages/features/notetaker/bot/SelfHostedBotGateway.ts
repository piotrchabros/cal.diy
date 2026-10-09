import type {
  NotetakerBotJoinRequest,
  NotetakerBotStateDto,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotJoinResponseSchema,
  notetakerBotStateSchema,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";
import { z } from "zod";
import type { INotetakerBotGateway } from "./INotetakerBotGateway";
import { createNotetakerBotGatewayError } from "./INotetakerBotGateway";

const DEFAULT_TIMEOUT_MS = 10_000;

const botErrorBodySchema = z.object({ error: z.string() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class SelfHostedBotGateway implements INotetakerBotGateway {
  private readonly baseUrl: string;
  private readonly botSecret: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(deps: { botUrl: string; botSecret: string; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = deps.botUrl.replace(/\/+$/, "");
    this.botSecret = deps.botSecret;
    this.fetchFn = deps.fetchFn;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async requestJoin(input: NotetakerBotJoinRequest): Promise<{ externalRef: string }> {
    const path = "/v1/sessions";
    const { status, text } = await this.send({ method: "POST", path, rawBody: JSON.stringify(input) });

    if (status === 422) {
      const errorBody = botErrorBodySchema.safeParse(parseJson(text));
      // The bot also answers 422 when it cannot read the request. That is a version mismatch, not a
      // bad link, so it is retried until the give-up deadline. A 422 without this code (the contract
      // allows an empty body) stays a link failure.
      if (errorBody.success && errorBody.data.error === "invalid_request") {
        throw createNotetakerBotGatewayError(
          "TRANSIENT",
          `Bot rejected POST ${path} as invalid_request (status 422)`
        );
      }
      throw createNotetakerBotGatewayError("LINK_UNUSABLE", `Bot rejected POST ${path} with status 422`);
    }
    if (status < 200 || status >= 300) {
      throw createNotetakerBotGatewayError("TRANSIENT", `POST ${path} failed with status ${status}`);
    }

    const parsed = notetakerBotJoinResponseSchema.safeParse(parseJson(text));
    if (!parsed.success || parsed.data.sessionId !== input.sessionId) {
      throw createNotetakerBotGatewayError("TRANSIENT", `POST ${path} returned an invalid response body`);
    }
    return { externalRef: parsed.data.externalRef };
  }

  async requestStop(input: { sessionId: string; reason: NotetakerBotStopReason }): Promise<void> {
    const path = `/v1/sessions/${encodeURIComponent(input.sessionId)}/stop`;
    const { status } = await this.send({
      method: "POST",
      path,
      rawBody: JSON.stringify({ reason: input.reason }),
    });

    if (status === 404 || (status >= 200 && status < 300)) return;
    throw createNotetakerBotGatewayError("TRANSIENT", `POST ${path} failed with status ${status}`);
  }

  async getState(sessionId: string): Promise<NotetakerBotStateDto | null> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    const { status, text } = await this.send({ method: "GET", path, rawBody: "" });

    if (status === 404) return null;
    if (status !== 200) {
      throw createNotetakerBotGatewayError("TRANSIENT", `GET ${path} failed with status ${status}`);
    }

    const parsed = notetakerBotStateSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw createNotetakerBotGatewayError("TRANSIENT", `GET ${path} returned an invalid response body`);
    }
    return parsed.data;
  }

  private async send(request: {
    method: "GET" | "POST";
    path: string;
    rawBody: string;
  }): Promise<{ status: number; text: string }> {
    const { method, path, rawBody } = request;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signNotetakerPayload({ secret: this.botSecret, timestamp, rawBody });

    const headers: Record<string, string> = {
      [NOTETAKER_TIMESTAMP_HEADER]: timestamp,
      [NOTETAKER_SIGNATURE_HEADER]: signature,
    };
    if (method === "POST") headers["Content-Type"] = "application/json";

    // Resolved per call because tests swap the global fetch after modules are loaded.
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    // AbortController + setTimeout rather than AbortSignal.timeout so fake timers can drive it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: rawBody } : {}),
        signal: controller.signal,
      });
      // The body is read inside the timeout window so a stalled stream is also aborted.
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      // Only the error name is reported: messages from fetch can echo the url or body.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      throw createNotetakerBotGatewayError("TRANSIENT", `${method} ${path} failed with ${errorName}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
