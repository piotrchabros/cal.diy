import type { RecallWebhookEnvelope } from "@calcom/features/notetaker/bot/recall/recallSchemas";
import type { NotetakerConfig } from "@calcom/features/notetaker/lib/config";
import {
  RECALL_WEBHOOK_ID_HEADER,
  RECALL_WEBHOOK_SIGNATURE_HEADER,
  RECALL_WEBHOOK_TIMESTAMP_HEADER,
  signRecallWebhookPayload,
} from "@calcom/lib/notetaker/recallWebhookSignature";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const harness = vi.hoisted(() => ({
  process: vi.fn<(envelope: RecallWebhookEnvelope) => Promise<string>>(),
  getRecall: vi.fn<() => NotetakerConfig["recall"]>(),
  afterCallbacks: [] as Array<() => Promise<void>>,
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mocking the container keeps the Prisma repositories and the real Recall client from loading.
vi.mock("@calcom/features/notetaker/di/RecallWebhookService.container", () => ({
  getRecallWebhookService: () => ({ processWithRetry: harness.process }),
}));

vi.mock("@calcom/features/notetaker/lib/config", () => ({
  getNotetakerConfig: () => ({ recall: harness.getRecall() }),
}));

vi.mock("@calcom/lib/logger", () => ({
  // The root logger is also used by the perf observer that defaultResponderForAppDir triggers.
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getSubLogger: () => harness.log },
}));

// `after` needs a request scope that a unit test does not have; capturing the callbacks also lets
// the tests prove the response is sent before processing starts.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (callback: () => Promise<void>) => {
      harness.afterCallbacks.push(callback);
    },
  };
});

const SECRET = `whsec_${Buffer.from("test-recall-webhook-secret").toString("base64")}`;
const ROTATED_SECRET = `whsec_${Buffer.from("rotated-recall-webhook-secret").toString("base64")}`;
const NOW = new Date("2026-10-12T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const WEBHOOK_URL = "http://localhost/api/notetaker/recall/webhook";
const WEBHOOK_ID = "msg_test_1";
const BOT_ID = "bot-1";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const OK_BODY = { ok: true };
const INVALID_SIGNATURE_BODY = { message: "Invalid signature" };

const RECALL_CONFIG: NonNullable<NotetakerConfig["recall"]> = {
  apiKey: "test-recall-api-key",
  region: "eu-central-1",
  webhookSecret: SECRET,
};

function buildEnvelope(): RecallWebhookEnvelope {
  return {
    event: "bot.in_call_recording",
    data: {
      data: { code: "in_call_recording", sub_code: null, updated_at: "2026-10-12T11:59:00.000Z" },
      bot: { id: BOT_ID, metadata: { notetakerSessionId: SESSION_ID } },
    },
  };
}

function signedHeaders(
  rawBody: string,
  overrides: { secret?: string; timestamp?: number; prefix?: "webhook" | "svix" } = {}
): Record<string, string> {
  const timestamp = String(overrides.timestamp ?? NOW_SECONDS);
  const prefix = overrides.prefix ?? "webhook";
  return {
    [`${prefix}-id`]: WEBHOOK_ID,
    [`${prefix}-timestamp`]: timestamp,
    [`${prefix}-signature`]: signRecallWebhookPayload({
      secret: overrides.secret ?? SECRET,
      webhookId: WEBHOOK_ID,
      timestamp,
      rawBody,
    }),
  };
}

// A request body can be read once, so every call builds a new request.
function post(rawBody: string, headers: Record<string, string>): Promise<Response> {
  return POST(new NextRequest(WEBHOOK_URL, { method: "POST", body: rawBody, headers }), {
    params: Promise.resolve({}),
  });
}

async function readResponse(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

async function runAfterCallbacks(): Promise<void> {
  for (const callback of harness.afterCallbacks.splice(0)) {
    await callback();
  }
}

function serializedLogCalls(): string {
  return Object.values(harness.log)
    .flatMap((fn) => fn.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

describe("POST /api/notetaker/recall/webhook", () => {
  beforeEach(() => {
    // Only Date is faked: the signature check reads the clock, and request.text() needs real timers.
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness.getRecall.mockReturnValue(RECALL_CONFIG);
    harness.process.mockResolvedValue("SYNCED");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    harness.afterCallbacks.length = 0;
  });

  it("acknowledges a valid webhook and processes it only once the after callback runs", async () => {
    const envelope = buildEnvelope();
    const rawBody = JSON.stringify(envelope);

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.process).not.toHaveBeenCalled();
    expect(harness.afterCallbacks).toHaveLength(1);

    await runAfterCallbacks();

    expect(harness.process).toHaveBeenCalledTimes(1);
    expect(harness.process).toHaveBeenCalledWith(envelope);
  });

  it("accepts the legacy svix-* header names", async () => {
    const rawBody = JSON.stringify(buildEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody, { prefix: "svix" })));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(1);
  });

  it("accepts a header carrying several signatures during secret rotation", async () => {
    const rawBody = JSON.stringify(buildEnvelope());
    const headers = signedHeaders(rawBody);
    const oldSignature = signedHeaders(rawBody, { secret: ROTATED_SECRET })[RECALL_WEBHOOK_SIGNATURE_HEADER];
    headers[RECALL_WEBHOOK_SIGNATURE_HEADER] = `${oldSignature} ${headers[RECALL_WEBHOOK_SIGNATURE_HEADER]}`;

    const response = await readResponse(await post(rawBody, headers));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(1);
  });

  it("rejects a signature made with another secret", async () => {
    const rawBody = JSON.stringify(buildEnvelope());

    const response = await readResponse(
      await post(rawBody, signedHeaders(rawBody, { secret: ROTATED_SECRET }))
    );

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.log.warn).toHaveBeenCalledWith(expect.any(String), {
      webhookId: WEBHOOK_ID,
      bodyLength: rawBody.length,
    });
  });

  it.each([
    RECALL_WEBHOOK_ID_HEADER,
    RECALL_WEBHOOK_TIMESTAMP_HEADER,
    RECALL_WEBHOOK_SIGNATURE_HEADER,
  ])("rejects a webhook missing the %s header", async (header) => {
    const rawBody = JSON.stringify(buildEnvelope());
    const headers = signedHeaders(rawBody);
    delete headers[header];

    const response = await readResponse(await post(rawBody, headers));

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
  });

  it("rejects a tampered body", async () => {
    const rawBody = JSON.stringify(buildEnvelope());
    const tampered = rawBody.replace(BOT_ID, "bot-2");

    const response = await readResponse(await post(tampered, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
  });

  it("rejects a stale timestamp", async () => {
    const rawBody = JSON.stringify(buildEnvelope());

    const response = await readResponse(
      await post(rawBody, signedHeaders(rawBody, { timestamp: NOW_SECONDS - 301 }))
    );

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
  });

  it("rejects every webhook when Recall is not configured", async () => {
    harness.getRecall.mockReturnValue(null);
    const rawBody = JSON.stringify(buildEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an unexpected payload shape", JSON.stringify({ event: "bot.done" })],
  ])("acknowledges %s with a valid signature without processing it", async (_label, rawBody) => {
    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.process).not.toHaveBeenCalled();
  });

  it("catches and logs a processing failure without leaking the payload", async () => {
    harness.process.mockRejectedValue(new Error("Recall API unavailable"));
    const rawBody = JSON.stringify(buildEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));
    await expect(runAfterCallbacks()).resolves.toBeUndefined();

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.log.error).toHaveBeenCalledWith(expect.any(String), {
      event: "bot.in_call_recording",
      botId: BOT_ID,
      message: "Recall API unavailable",
    });
    const logged = serializedLogCalls();
    expect(logged).not.toContain(SESSION_ID);
    expect(logged).not.toContain(SECRET);
  });
});
