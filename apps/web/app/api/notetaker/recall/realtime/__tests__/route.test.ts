import type { RecallRealtimeEnvelope } from "@calcom/features/notetaker/bot/recall/recallSchemas";
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
  handle: vi.fn<(envelope: RecallRealtimeEnvelope, webhookId: string | null) => Promise<void>>(),
  getRecall: vi.fn<() => NotetakerConfig["recall"]>(),
  isAgentUsable: vi.fn<() => boolean>(),
  afterCallbacks: [] as Array<() => Promise<void>>,
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mocking the container keeps the Prisma repositories, the Recall client and the Claude agent from loading.
vi.mock("@calcom/features/notetaker/di/RecallRealtimeEventService.container", () => ({
  getRecallRealtimeEventService: () => ({ handle: harness.handle }),
}));

vi.mock("@calcom/features/notetaker/lib/config", () => ({
  getNotetakerConfig: () => ({ recall: harness.getRecall() }),
  isNotetakerAgentUsable: () => harness.isAgentUsable(),
}));

vi.mock("@calcom/lib/logger", () => ({
  // The root logger is also used by the perf observer that defaultResponderForAppDir triggers.
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getSubLogger: () => harness.log },
}));

// `after` needs a request scope that a unit test does not have; capturing the callbacks also lets
// the tests prove the response is sent before the agent runs.
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
const OTHER_SECRET = `whsec_${Buffer.from("other-recall-webhook-secret").toString("base64")}`;
const NOW = new Date("2026-10-12T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REALTIME_URL = "http://localhost/api/notetaker/recall/realtime";
const WEBHOOK_ID = "msg_realtime_1";
const BOT_ID = "bot-1";

const OK_BODY = { ok: true };
const INVALID_SIGNATURE_BODY = { message: "Invalid signature" };

const RECALL_CONFIG: NonNullable<NotetakerConfig["recall"]> = {
  apiKey: "test-recall-api-key",
  region: "eu-central-1",
  webhookSecret: SECRET,
};

function buildChatEnvelope(): RecallRealtimeEnvelope {
  return {
    event: "participant_events.chat_message",
    data: {
      data: {
        participant: { id: 1, name: "Anna" },
        data: { text: "BlueBeeBot hi", to: "everyone" },
      },
      bot: { id: BOT_ID, metadata: { notetakerSessionId: "s1" } },
    },
  };
}

function signedHeaders(
  rawBody: string,
  overrides: { secret?: string; prefix?: "webhook" | "svix" } = {}
): Record<string, string> {
  const timestamp = String(NOW_SECONDS);
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
  return POST(new NextRequest(REALTIME_URL, { method: "POST", body: rawBody, headers }), {
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

describe("POST /api/notetaker/recall/realtime", () => {
  beforeEach(() => {
    // Only Date is faked: the signature check reads the clock, and request.text() needs real timers.
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    harness.getRecall.mockReturnValue(RECALL_CONFIG);
    harness.isAgentUsable.mockReturnValue(true);
    harness.handle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    harness.afterCallbacks.length = 0;
  });

  it("acknowledges a chat message and hands it to the service only once the after callback runs", async () => {
    const envelope = buildChatEnvelope();
    const rawBody = JSON.stringify(envelope);

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.handle).not.toHaveBeenCalled();
    expect(harness.afterCallbacks).toHaveLength(1);

    await runAfterCallbacks();

    expect(harness.handle).toHaveBeenCalledTimes(1);
    expect(harness.handle).toHaveBeenCalledWith(envelope, WEBHOOK_ID);
  });

  it("accepts the legacy svix-* header names", async () => {
    const rawBody = JSON.stringify(buildChatEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody, { prefix: "svix" })));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(1);
  });

  it("rejects every event when Recall is not configured", async () => {
    harness.getRecall.mockReturnValue(null);
    const rawBody = JSON.stringify(buildChatEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.handle).not.toHaveBeenCalled();
  });

  it("rejects a signature made with another secret", async () => {
    const rawBody = JSON.stringify(buildChatEnvelope());

    const response = await readResponse(
      await post(rawBody, signedHeaders(rawBody, { secret: OTHER_SECRET }))
    );

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.handle).not.toHaveBeenCalled();
    expect(harness.log.warn).toHaveBeenCalledWith(expect.any(String), {
      webhookId: WEBHOOK_ID,
      bodyLength: rawBody.length,
    });
  });

  it.each([
    RECALL_WEBHOOK_ID_HEADER,
    RECALL_WEBHOOK_TIMESTAMP_HEADER,
    RECALL_WEBHOOK_SIGNATURE_HEADER,
  ])("rejects an event missing the %s header", async (header) => {
    const rawBody = JSON.stringify(buildChatEnvelope());
    const headers = signedHeaders(rawBody);
    delete headers[header];

    const response = await readResponse(await post(rawBody, headers));

    expect(response).toEqual({ status: 401, body: INVALID_SIGNATURE_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.handle).not.toHaveBeenCalled();
  });

  it("acknowledges without processing when the agent is not usable", async () => {
    harness.isAgentUsable.mockReturnValue(false);
    const rawBody = JSON.stringify(buildChatEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.handle).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    [
      "a payload without data.bot",
      JSON.stringify({ event: "participant_events.chat_message", data: { data: null } }),
    ],
  ])("acknowledges %s with a valid signature without processing it", async (_label, rawBody) => {
    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.afterCallbacks).toHaveLength(0);
    expect(harness.handle).not.toHaveBeenCalled();
    expect(harness.log.warn).toHaveBeenCalledWith(expect.any(String), { webhookId: WEBHOOK_ID });
  });

  it("catches and logs a processing failure inside the after callback", async () => {
    harness.handle.mockRejectedValue(new Error("Anthropic API unavailable"));
    const rawBody = JSON.stringify(buildChatEnvelope());

    const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));
    await expect(runAfterCallbacks()).resolves.toBeUndefined();

    expect(response).toEqual({ status: 200, body: OK_BODY });
    expect(harness.log.error).toHaveBeenCalledWith(expect.any(String), {
      event: "participant_events.chat_message",
      botId: BOT_ID,
      message: "Anthropic API unavailable",
    });
  });
});
