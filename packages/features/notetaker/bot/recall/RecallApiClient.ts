import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { RecallRegion } from "../../lib/config";
import type {
  RecallBot,
  RecallCreateBotRequest,
  RecallCreateTranscriptRequest,
  RecallTranscriptArtifact,
  RecallTranscriptEntry,
} from "./recallSchemas";
import {
  recallBotListSchema,
  recallBotSchema,
  recallTranscriptArtifactSchema,
  recallTranscriptDownloadSchema,
} from "./recallSchemas";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_TOTAL_RETRY_WAIT_MS = 40_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
const UNAVAILABLE_WAIT_MS = 10_000;
const INSUFFICIENT_STORAGE_WAIT_MS = 30_000;
const MAX_JITTER_SECONDS = 5;

export type RecallApiErrorKind =
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "BAD_REQUEST"
  | "HTTP"
  | "NETWORK"
  | "TIMEOUT"
  | "INVALID_RESPONSE";

// ErrorCode has no 429 or 503 member, so the discriminator travels in `data`.
export function createRecallApiError(
  kind: RecallApiErrorKind,
  message: string,
  extra?: { status?: number; fieldNames?: string[] }
): ErrorWithCode {
  const code = kind === "BAD_REQUEST" ? ErrorCode.BadRequest : ErrorCode.InternalServerError;
  return new ErrorWithCode(code, message, {
    recallErrorKind: kind,
    status: extra?.status ?? null,
    fieldNames: extra?.fieldNames ?? [],
  });
}

export function getRecallApiErrorInfo(
  error: unknown
): { kind: RecallApiErrorKind; status: number | null; fieldNames: string[] } | null {
  if (!(error instanceof ErrorWithCode)) return null;
  const kind = error.data?.recallErrorKind;
  if (
    kind !== "RATE_LIMITED" &&
    kind !== "UNAVAILABLE" &&
    kind !== "BAD_REQUEST" &&
    kind !== "HTTP" &&
    kind !== "NETWORK" &&
    kind !== "TIMEOUT" &&
    kind !== "INVALID_RESPONSE"
  ) {
    return null;
  }
  const status = typeof error.data?.status === "number" ? error.data.status : null;
  const rawFieldNames = error.data?.fieldNames;
  const fieldNames = Array.isArray(rawFieldNames)
    ? rawFieldNames.filter((name): name is string => typeof name === "string")
    : [];
  return { kind, status, fieldNames };
}

export interface IRecallApiClient {
  createBot(body: RecallCreateBotRequest): Promise<RecallBot>;
  /** Null on 404. */
  retrieveBot(botId: string): Promise<RecallBot | null>;
  /** First page only. */
  listBotsByMetadata(key: string, value: string): Promise<RecallBot[]>;
  /** NOT_FOUND on 404, NOT_IN_CALL on any other 4xx (the bot is not in a call that can be left). */
  leaveCall(botId: string): Promise<"OK" | "NOT_FOUND" | "NOT_IN_CALL">;
  /** Only works for bots that have not joined yet. */
  deleteScheduledBot(botId: string): Promise<"OK" | "NOT_FOUND" | "NOT_DELETABLE">;
  createTranscript(recordingId: string, body: RecallCreateTranscriptRequest): Promise<{ id: string }>;
  /** Null on 404. */
  retrieveTranscript(transcriptId: string): Promise<RecallTranscriptArtifact | null>;
  /** The download URL is presigned, so no Authorization header is sent. */
  downloadTranscript(downloadUrl: string): Promise<RecallTranscriptEntry[]>;
}

type RequestOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  // Used in messages instead of `path`, which can carry ids and query values.
  template: string;
  body?: unknown;
  // Safe to repeat after a network error or timeout.
  idempotent: boolean;
  timeoutMs: number;
};

type RawResponse = { status: number; text: string; retryAfter: string | null };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

export class RecallApiClient implements IRecallApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxTotalRetryWaitMs: number;

  constructor(deps: {
    apiKey: string;
    region: RecallRegion;
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    timeoutMs?: number;
    downloadTimeoutMs?: number;
    maxAttempts?: number;
    maxTotalRetryWaitMs?: number;
  }) {
    this.baseUrl = `https://${deps.region}.recall.ai/api/v1`;
    this.apiKey = deps.apiKey;
    this.fetchFn = deps.fetchFn;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxTotalRetryWaitMs = deps.maxTotalRetryWaitMs ?? DEFAULT_MAX_TOTAL_RETRY_WAIT_MS;
  }

  async createBot(body: RecallCreateBotRequest): Promise<RecallBot> {
    const template = "POST /bot/";
    const response = await this.send({
      method: "POST",
      path: "/bot/",
      template,
      body,
      idempotent: false,
      timeoutMs: this.timeoutMs,
    });
    this.assertSuccess(response, template);
    return this.parse(recallBotSchema, response.text, template);
  }

  async retrieveBot(botId: string): Promise<RecallBot | null> {
    const template = "GET /bot/{id}/";
    const response = await this.send({
      method: "GET",
      path: `/bot/${encodeURIComponent(botId)}/`,
      template,
      idempotent: true,
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 404) return null;
    this.assertSuccess(response, template);
    return this.parse(recallBotSchema, response.text, template);
  }

  async listBotsByMetadata(key: string, value: string): Promise<RecallBot[]> {
    const template = "GET /bot/?metadata__{key}={value}";
    const response = await this.send({
      method: "GET",
      path: `/bot/?${encodeURIComponent(`metadata__${key}`)}=${encodeURIComponent(value)}`,
      template,
      idempotent: true,
      timeoutMs: this.timeoutMs,
    });
    this.assertSuccess(response, template);
    return this.parse(recallBotListSchema, response.text, template).results;
  }

  async leaveCall(botId: string): Promise<"OK" | "NOT_FOUND" | "NOT_IN_CALL"> {
    const template = "POST /bot/{id}/leave_call/";
    const response = await this.send({
      method: "POST",
      path: `/bot/${encodeURIComponent(botId)}/leave_call/`,
      template,
      body: {},
      idempotent: true,
      timeoutMs: this.timeoutMs,
    });
    if (response.status >= 200 && response.status < 300) return "OK";
    if (response.status === 404) return "NOT_FOUND";
    if (response.status >= 400 && response.status < 500) return "NOT_IN_CALL";
    throw this.httpError(response, template);
  }

  async deleteScheduledBot(botId: string): Promise<"OK" | "NOT_FOUND" | "NOT_DELETABLE"> {
    const template = "DELETE /bot/{id}/";
    const response = await this.send({
      method: "DELETE",
      path: `/bot/${encodeURIComponent(botId)}/`,
      template,
      idempotent: true,
      timeoutMs: this.timeoutMs,
    });
    if (response.status >= 200 && response.status < 300) return "OK";
    if (response.status === 404) return "NOT_FOUND";
    if (response.status >= 400 && response.status < 500) return "NOT_DELETABLE";
    throw this.httpError(response, template);
  }

  async createTranscript(recordingId: string, body: RecallCreateTranscriptRequest): Promise<{ id: string }> {
    const template = "POST /recording/{id}/create_transcript/";
    const response = await this.send({
      method: "POST",
      path: `/recording/${encodeURIComponent(recordingId)}/create_transcript/`,
      template,
      body,
      idempotent: false,
      timeoutMs: this.timeoutMs,
    });
    this.assertSuccess(response, template);
    const { id } = this.parse(recallTranscriptArtifactSchema, response.text, template);
    return { id };
  }

  async retrieveTranscript(transcriptId: string): Promise<RecallTranscriptArtifact | null> {
    const template = "GET /transcript/{id}/";
    const response = await this.send({
      method: "GET",
      path: `/transcript/${encodeURIComponent(transcriptId)}/`,
      template,
      idempotent: true,
      timeoutMs: this.timeoutMs,
    });
    if (response.status === 404) return null;
    this.assertSuccess(response, template);
    return this.parse(recallTranscriptArtifactSchema, response.text, template);
  }

  async downloadTranscript(downloadUrl: string): Promise<RecallTranscriptEntry[]> {
    const template = "GET <transcript download_url>";
    const response = await this.send({
      method: "GET",
      path: downloadUrl,
      template,
      idempotent: true,
      timeoutMs: this.downloadTimeoutMs,
    });
    this.assertSuccess(response, template);
    return this.parse(recallTranscriptDownloadSchema, response.text, template);
  }

  private assertSuccess(response: RawResponse, template: string): void {
    if (response.status >= 200 && response.status < 300) return;
    throw this.httpError(response, template);
  }

  private httpError(response: RawResponse, template: string): ErrorWithCode {
    const message = `${template} failed with status ${response.status}`;
    if (response.status === 400) {
      const body = parseJson(response.text);
      const fieldNames =
        body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
      return createRecallApiError("BAD_REQUEST", message, { status: 400, fieldNames });
    }
    return createRecallApiError("HTTP", message, { status: response.status });
  }

  // Structural so schemas with defaults (input type differs from output type) are accepted.
  private parse<T>(
    schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
    text: string,
    template: string
  ): T {
    const parsed = schema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw createRecallApiError("INVALID_RESPONSE", `${template} returned an invalid response body`);
    }
    return parsed.data;
  }

  private async send(options: RequestOptions): Promise<RawResponse> {
    let attempt = 0;
    let waitedMs = 0;
    let networkRetried = false;

    for (;;) {
      attempt += 1;
      let response: RawResponse;
      try {
        response = await this.sendOnce(options);
      } catch (error) {
        if (options.idempotent && !networkRetried) {
          networkRetried = true;
          continue;
        }
        throw error;
      }

      const baseWaitMs = this.getRetryBaseWaitMs(response);
      if (baseWaitMs === null) return response;

      const exhausted = response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE";
      const waitMs = baseWaitMs + Math.ceil(this.random() * MAX_JITTER_SECONDS) * 1000;
      if (attempt >= this.maxAttempts || waitedMs + waitMs > this.maxTotalRetryWaitMs) {
        throw createRecallApiError(
          exhausted,
          `${options.template} failed with status ${response.status} after ${attempt} attempts`,
          { status: response.status }
        );
      }
      waitedMs += waitMs;
      await this.sleep(waitMs);
    }
  }

  private getRetryBaseWaitMs(response: RawResponse): number | null {
    if (response.status === 429) {
      return parseRetryAfterMs(response.retryAfter) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
    }
    if (response.status === 503) return UNAVAILABLE_WAIT_MS;
    if (response.status === 507) return INSUFFICIENT_STORAGE_WAIT_MS;
    return null;
  }

  private async sendOnce(options: RequestOptions): Promise<RawResponse> {
    const { method, path, template, body, timeoutMs } = options;
    const isDownload = path.startsWith("https://") || path.startsWith("http://");

    const headers: Record<string, string> = { accept: "application/json" };
    if (!isDownload) {
      headers.Authorization = this.apiKey;
      if (body !== undefined) headers["content-type"] = "application/json";
    }

    // Resolved per call because tests swap the global fetch after modules are loaded.
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    // AbortController + setTimeout rather than AbortSignal.timeout so fake timers can drive it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchFn(isDownload ? path : `${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      // The body is read inside the timeout window so a stalled stream is also aborted.
      const text = await response.text();
      return { status: response.status, text, retryAfter: response.headers.get("retry-after") };
    } catch (error) {
      // Only the error name is reported: messages from fetch can echo the url, which holds the
      // API key's region path or a presigned signature.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      if (timedOut) {
        throw createRecallApiError("TIMEOUT", `${template} timed out after ${timeoutMs}ms`);
      }
      throw createRecallApiError("NETWORK", `${template} failed with ${errorName}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
