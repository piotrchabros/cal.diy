import { describe, expect, it, vi } from "vitest";
import { getRecallApiErrorInfo, RecallApiClient } from "./RecallApiClient";
import type { RecallCreateBotRequest, RecallCreateTranscriptRequest } from "./recallSchemas";

const API_KEY = "secret-api-key-123";
const PRESIGNED_URL = "https://files.example.com/t.json?X-Signature=presigned-secret";
const MEETING_URL = "https://meet.google.com/abc-defg-hij";

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : payload, { status, headers });
}

function setup(
  responses: Array<Response | Error | (() => Promise<Response>)>,
  overrides: Partial<ConstructorParameters<typeof RecallApiClient>[0]> = {}
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  }) as unknown as typeof fetch;
  const sleep = vi.fn(async () => {});
  const client = new RecallApiClient({
    apiKey: API_KEY,
    region: "eu-central-1",
    fetchFn,
    sleep,
    random: () => 0,
    ...overrides,
  });
  return { client, calls, sleep };
}

const bot = { id: "bot-1", status_changes: [], recordings: [] };

const createBotBody: RecallCreateBotRequest = {
  meeting_url: MEETING_URL,
  bot_name: "Notetaker",
  join_at: "2026-01-01T10:00:00.000Z",
  metadata: { notetakerSessionId: "s1" },
  chat: { on_bot_join: { send_to: "everyone", message: "hi", pin: false } },
  automatic_leave: {
    waiting_room_timeout: 600,
    noone_joined_timeout: 600,
    everyone_left_timeout: { timeout: 60 },
    in_call_recording_timeout: 3600,
  },
};

const transcriptBody: RecallCreateTranscriptRequest = {
  provider: { recallai_async: { language_code: "auto" } },
  diarization: { use_separate_streams_when_available: true },
};

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("RecallApiClient requests", () => {
  it("createBot posts the body with auth headers", async () => {
    const { client, calls } = setup([jsonResponse(201, bot)]);
    await expect(client.createBot(createBotBody)).resolves.toMatchObject({ id: "bot-1" });
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/bot/");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(createBotBody);
    expect(headersOf(calls[0])).toMatchObject({
      Authorization: API_KEY,
      accept: "application/json",
      "content-type": "application/json",
    });
  });

  it("parses a video_mixed shortcut and tolerates recordings without shortcuts", async () => {
    const withVideo = {
      id: "bot-1",
      status_changes: [],
      recordings: [
        {
          id: "rec-1",
          expires_at: "2026-02-01T00:00:00Z",
          media_shortcuts: {
            video_mixed: {
              id: "vid-1",
              status: { code: "done" },
              data: { download_url: PRESIGNED_URL },
              format: "mp4",
            },
          },
        },
        { id: "rec-2" },
        { id: "rec-3", media_shortcuts: {} },
      ],
    };
    const { client } = setup([jsonResponse(200, withVideo)]);

    const result = await client.retrieveBot("bot-1");

    expect(result?.recordings[0]).toMatchObject({
      expires_at: "2026-02-01T00:00:00Z",
      media_shortcuts: { video_mixed: { id: "vid-1", format: "mp4", data: { download_url: PRESIGNED_URL } } },
    });
    expect(result?.recordings[1]?.media_shortcuts).toBeUndefined();
    expect(result?.recordings[2]?.media_shortcuts?.video_mixed).toBeUndefined();
  });

  it("retrieveBot gets by id and maps 404 to null", async () => {
    const { client, calls } = setup([jsonResponse(200, bot), jsonResponse(404, {})]);
    await expect(client.retrieveBot("bot-1")).resolves.toMatchObject({ id: "bot-1" });
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/bot/bot-1/");
    expect(calls[0].init.method).toBe("GET");
    await expect(client.retrieveBot("bot-2")).resolves.toBeNull();
  });

  it("listBotsByMetadata url-encodes the filter and returns the first page", async () => {
    const { client, calls } = setup([jsonResponse(200, { results: [bot], next: null })]);
    await expect(client.listBotsByMetadata("notetakerSessionId", "a b&c")).resolves.toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://eu-central-1.recall.ai/api/v1/bot/?metadata__notetakerSessionId=a%20b%26c"
    );
  });

  it("leaveCall maps statuses", async () => {
    const { client, calls } = setup([jsonResponse(200, {}), jsonResponse(404, {}), jsonResponse(409, {})]);
    await expect(client.leaveCall("b")).resolves.toBe("OK");
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/bot/b/leave_call/");
    expect(calls[0].init.method).toBe("POST");
    await expect(client.leaveCall("b")).resolves.toBe("NOT_FOUND");
    await expect(client.leaveCall("b")).resolves.toBe("NOT_IN_CALL");
  });

  it("deleteScheduledBot maps statuses", async () => {
    const { client, calls } = setup([jsonResponse(204, ""), jsonResponse(404, {}), jsonResponse(405, {})]);
    await expect(client.deleteScheduledBot("b")).resolves.toBe("OK");
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/bot/b/");
    expect(calls[0].init.method).toBe("DELETE");
    await expect(client.deleteScheduledBot("b")).resolves.toBe("NOT_FOUND");
    await expect(client.deleteScheduledBot("b")).resolves.toBe("NOT_DELETABLE");
  });

  it("createTranscript posts to the recording", async () => {
    const { client, calls } = setup([jsonResponse(201, { id: "t1", status: { code: "processing" } })]);
    await expect(client.createTranscript("r1", transcriptBody)).resolves.toEqual({ id: "t1" });
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/recording/r1/create_transcript/");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(transcriptBody);
  });

  it("retrieveTranscript gets by id and maps 404 to null", async () => {
    const { client, calls } = setup([jsonResponse(200, { id: "t1" }), jsonResponse(404, {})]);
    await expect(client.retrieveTranscript("t1")).resolves.toMatchObject({ id: "t1" });
    expect(calls[0].url).toBe("https://eu-central-1.recall.ai/api/v1/transcript/t1/");
    await expect(client.retrieveTranscript("t2")).resolves.toBeNull();
  });

  it("downloadTranscript sends no Authorization header", async () => {
    const entries = [{ participant: { id: 1, name: "Ann" }, words: [] }];
    const { client, calls } = setup([jsonResponse(200, entries)]);
    await expect(client.downloadTranscript(PRESIGNED_URL)).resolves.toHaveLength(1);
    expect(calls[0].url).toBe(PRESIGNED_URL);
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it("reports INVALID_RESPONSE for a body that fails the schema", async () => {
    const { client } = setup([jsonResponse(200, { nope: true })]);
    const error = await client.retrieveBot("b").catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(error)?.kind).toBe("INVALID_RESPONSE");
  });
});

describe("RecallApiClient retries", () => {
  it("waits for Retry-After seconds on 429 then succeeds", async () => {
    const { client, sleep } = setup([jsonResponse(429, {}, { "retry-after": "7" }), jsonResponse(200, bot)]);
    await client.retrieveBot("b");
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("supports an HTTP-date Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { client, sleep } = setup([
        jsonResponse(429, {}, { "retry-after": "Thu, 01 Jan 2026 00:00:12 GMT" }),
        jsonResponse(200, bot),
      ]);
      await client.retrieveBot("b");
      expect(sleep).toHaveBeenCalledWith(12000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to 5s for 429 without Retry-After and adds jitter", async () => {
    const { client, sleep } = setup([jsonResponse(429, {}), jsonResponse(200, bot)], { random: () => 0.5 });
    await client.retrieveBot("b");
    expect(sleep).toHaveBeenCalledWith(5000 + 3000);
  });

  it("waits 10s on 503 and 30s on 507", async () => {
    const { client, sleep } = setup([jsonResponse(503, {}), jsonResponse(507, {}), jsonResponse(200, bot)]);
    await client.retrieveBot("b");
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("retries createBot on 429", async () => {
    const { client, calls } = setup([jsonResponse(429, {}), jsonResponse(201, bot)]);
    await client.createBot(createBotBody);
    expect(calls).toHaveLength(2);
  });

  it("gives up with RATE_LIMITED when attempts run out", async () => {
    const { client, calls } = setup([jsonResponse(429, {}), jsonResponse(429, {}), jsonResponse(429, {})], {
      maxAttempts: 3,
    });
    const error = await client.retrieveBot("b").catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(error)).toMatchObject({ kind: "RATE_LIMITED", status: 429 });
    expect(calls).toHaveLength(3);
  });

  it("gives up with UNAVAILABLE when the wait budget is exhausted", async () => {
    const { client, calls } = setup([jsonResponse(503, {}), jsonResponse(503, {})], {
      maxTotalRetryWaitMs: 15_000,
    });
    const error = await client.retrieveBot("b").catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(error)).toMatchObject({ kind: "UNAVAILABLE", status: 503 });
    expect(calls).toHaveLength(2);
  });

  it("reports UNAVAILABLE for 507 when the budget is smaller than one wait", async () => {
    const { client, calls } = setup([jsonResponse(507, {})], { maxTotalRetryWaitMs: 20_000 });
    const error = await client.retrieveBot("b").catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(error)).toMatchObject({ kind: "UNAVAILABLE", status: 507 });
    expect(calls).toHaveLength(1);
  });

  it("does not retry createBot or createTranscript after a network error", async () => {
    const first = setup([new TypeError("fetch failed")]);
    const botError = await first.client.createBot(createBotBody).catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(botError)?.kind).toBe("NETWORK");
    expect(first.calls).toHaveLength(1);

    const second = setup([new TypeError("fetch failed")]);
    const transcriptError = await second.client
      .createTranscript("r", transcriptBody)
      .catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(transcriptError)?.kind).toBe("NETWORK");
    expect(second.calls).toHaveLength(1);
  });

  it("does not retry createBot after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const hang = () =>
        new Promise<Response>(() => {
          /* never settles; the abort path is driven by the timer */
        });
      const calls: number[] = [];
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(1);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          void hang;
        });
      }) as unknown as typeof fetch;
      const client = new RecallApiClient({
        apiKey: API_KEY,
        region: "eu-central-1",
        fetchFn,
        sleep: async () => {},
        random: () => 0,
        timeoutMs: 1000,
      });
      const pending = client.createBot(createBotBody).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getRecallApiErrorInfo(await pending)?.kind).toBe("TIMEOUT");
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a GET once after a network error", async () => {
    const { client, calls } = setup([new TypeError("fetch failed"), jsonResponse(200, bot)]);
    await expect(client.retrieveBot("b")).resolves.toMatchObject({ id: "bot-1" });
    expect(calls).toHaveLength(2);
  });

  it("gives up a GET after the second network error", async () => {
    const { client, calls } = setup([new TypeError("a"), new TypeError("b")]);
    const error = await client.retrieveBot("b").catch((e: unknown) => e);
    expect(getRecallApiErrorInfo(error)?.kind).toBe("NETWORK");
    expect(calls).toHaveLength(2);
  });

  it("retries leaveCall and deleteScheduledBot once after a network error", async () => {
    const leave = setup([new TypeError("x"), jsonResponse(200, {})]);
    await expect(leave.client.leaveCall("b")).resolves.toBe("OK");
    const del = setup([new TypeError("x"), jsonResponse(204, "")]);
    await expect(del.client.deleteScheduledBot("b")).resolves.toBe("OK");
  });
});

describe("RecallApiClient errors", () => {
  it("maps 400 to BAD_REQUEST with the top-level field names", async () => {
    const { client } = setup([jsonResponse(400, { meeting_url: ["invalid"], join_at: ["bad"] })]);
    const error = await client.createBot(createBotBody).catch((e: unknown) => e);
    const info = getRecallApiErrorInfo(error);
    expect(info?.kind).toBe("BAD_REQUEST");
    expect(info?.status).toBe(400);
    expect(info?.fieldNames).toEqual(expect.arrayContaining(["meeting_url", "join_at"]));
  });

  it("maps 400 with a non-object body to BAD_REQUEST without field names", async () => {
    const { client } = setup([jsonResponse(400, "oops")]);
    const info = getRecallApiErrorInfo(await client.createBot(createBotBody).catch((e: unknown) => e));
    expect(info).toMatchObject({ kind: "BAD_REQUEST", fieldNames: [] });
  });

  it("maps other statuses to HTTP", async () => {
    const { client } = setup([jsonResponse(401, {}), jsonResponse(500, {})]);
    expect(getRecallApiErrorInfo(await client.retrieveBot("b").catch((e: unknown) => e))).toMatchObject({
      kind: "HTTP",
      status: 401,
    });
    expect(getRecallApiErrorInfo(await client.leaveCall("b").catch((e: unknown) => e))).toMatchObject({
      kind: "HTTP",
      status: 500,
    });
  });

  it("returns null info for unrelated errors", () => {
    expect(getRecallApiErrorInfo(new Error("x"))).toBeNull();
  });

  it("never puts the key, meeting url, presigned url or response body in messages", async () => {
    const leaky = "response-body-secret";
    const { client } = setup([
      jsonResponse(400, { meeting_url: leaky }),
      jsonResponse(500, leaky),
      new TypeError(`fetch failed ${PRESIGNED_URL}`),
      jsonResponse(200, { bad: leaky }),
    ]);
    const errors = [
      await client.createBot(createBotBody).catch((e: unknown) => e),
      await client.retrieveBot("b").catch((e: unknown) => e),
      await client.createBot(createBotBody).catch((e: unknown) => e),
      await client.retrieveTranscript("t").catch((e: unknown) => e),
    ];
    for (const error of errors) {
      const message = (error as Error).message;
      for (const secret of [API_KEY, MEETING_URL, PRESIGNED_URL, "presigned-secret", leaky]) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("keeps the presigned url out of download error messages", async () => {
    const { client } = setup([jsonResponse(403, {})]);
    const error = await client.downloadTranscript(PRESIGNED_URL).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("presigned-secret");
    expect(getRecallApiErrorInfo(error)).toMatchObject({ kind: "HTTP", status: 403 });
  });
});
