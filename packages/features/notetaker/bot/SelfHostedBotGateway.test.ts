import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotJoinRequestSchema,
  signNotetakerPayload,
  verifyNotetakerSignature,
} from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNotetakerBotGatewayFailure } from "./INotetakerBotGateway";
import { SelfHostedBotGateway } from "./SelfHostedBotGateway";

const BOT_URL = "https://bot.example.test";
const SECRET = "test-bot-secret-value";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2030-01-01T10:00:00.000Z");
const NOW_SECONDS = 1893492000;

function buildJoinRequest(): NotetakerBotJoinRequest {
  return notetakerBotJoinRequestSchema.parse({
    sessionId: SESSION_ID,
    platform: "GOOGLE_MEET",
    meetingUrl: "https://meet.example.test/abc-defg-hij",
    displayName: "Example Notetaker for Jane Host",
    noticeMessage: "This meeting is being transcribed by an automated notetaker.",
    scheduledStartAt: "2030-01-01T10:00:00.000Z",
    callbackUrl: "https://app.example.test/api/notetaker/events",
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
    },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function getSentRequest(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [input, init] = fetchFn.mock.calls[0];
  if (typeof input !== "string") throw new Error("expected the request url to be a string");
  return {
    url: input,
    method: init?.method,
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined,
    signal: init?.signal,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("SelfHostedBotGateway", () => {
  const fetchFn = vi.fn<typeof fetch>();

  function buildGateway(overrides: { botUrl?: string; timeoutMs?: number } = {}) {
    return new SelfHostedBotGateway({
      botUrl: overrides.botUrl ?? BOT_URL,
      botSecret: SECRET,
      fetchFn,
      timeoutMs: overrides.timeoutMs,
    });
  }

  beforeEach(() => {
    fetchFn.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("requestJoin", () => {
    it("POSTs to /v1/sessions", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, externalRef: "ref-1" }, 202));

      await buildGateway().requestJoin(buildJoinRequest());

      const sent = getSentRequest(fetchFn);
      expect(sent.url).toBe("https://bot.example.test/v1/sessions");
      expect(sent.method).toBe("POST");
    });

    it("does not double the slash when botUrl has trailing slashes", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, externalRef: "ref-1" }, 202));

      await buildGateway({ botUrl: "https://bot.example.test//" }).requestJoin(buildJoinRequest());

      expect(getSentRequest(fetchFn).url).toBe("https://bot.example.test/v1/sessions");
    });

    it("signs exactly the body it sends, with the timestamp it sends", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, externalRef: "ref-1" }, 202));
      const input = buildJoinRequest();

      await buildGateway().requestJoin(input);

      const sent = getSentRequest(fetchFn);
      const timestamp = sent.headers.get(NOTETAKER_TIMESTAMP_HEADER);
      const signature = sent.headers.get(NOTETAKER_SIGNATURE_HEADER);
      expect(timestamp).toBe(String(NOW_SECONDS));
      expect(sent.body).toBeDefined();
      const rawBody = sent.body ?? "";
      expect(
        verifyNotetakerSignature({
          secret: SECRET,
          timestamp,
          signature,
          rawBody,
          nowSeconds: NOW_SECONDS,
        })
      ).toBe(true);
      expect(signNotetakerPayload({ secret: SECRET, timestamp: timestamp ?? "", rawBody })).toBe(signature);
      expect(JSON.parse(rawBody)).toEqual(input);
      expect(sent.headers.get("Content-Type")).toBe("application/json");
    });

    it("returns the externalRef on 202", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, externalRef: "ref-1" }, 202));

      await expect(buildGateway().requestJoin(buildJoinRequest())).resolves.toEqual({
        externalRef: "ref-1",
      });
    });

    it("maps 422 to LINK_UNUSABLE", async () => {
      fetchFn.mockResolvedValueOnce(textResponse("", 422));

      const error = await captureError(buildGateway().requestJoin(buildJoinRequest()));

      expect(getNotetakerBotGatewayFailure(error)).toBe("LINK_UNUSABLE");
    });

    it.each([500, 502, 503, 401])("maps %i to TRANSIENT", async (status) => {
      fetchFn.mockResolvedValueOnce(textResponse("", status));

      const error = await captureError(buildGateway().requestJoin(buildJoinRequest()));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });

    it("maps a network error to TRANSIENT", async () => {
      fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));

      const error = await captureError(buildGateway().requestJoin(buildJoinRequest()));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });

    it.each([
      ["a non-JSON body", () => textResponse("not json", 202)],
      ["a missing externalRef", () => jsonResponse({ sessionId: SESSION_ID }, 202)],
      [
        "a mismatching sessionId",
        () => jsonResponse({ sessionId: "00000000-0000-4000-8000-000000000002", externalRef: "ref-1" }, 202),
      ],
    ])("maps a 202 with %s to TRANSIENT", async (_name, buildResponse) => {
      fetchFn.mockResolvedValueOnce(buildResponse());

      const error = await captureError(buildGateway().requestJoin(buildJoinRequest()));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });
  });

  describe("timeout", () => {
    function hangUntilAborted() {
      fetchFn.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          })
      );
    }

    it("rejects with TRANSIENT once the default 10_000 ms elapse", async () => {
      hangUntilAborted();
      let settled = false;
      const promise = buildGateway().requestJoin(buildJoinRequest());
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      const assertion = expect(promise).rejects.toSatisfy(
        (error) => getNotetakerBotGatewayFailure(error) === "TRANSIENT"
      );

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    });

    it("honours a timeoutMs override", async () => {
      hangUntilAborted();
      let settled = false;
      const promise = buildGateway({ timeoutMs: 50 }).getState(SESSION_ID);
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      const assertion = expect(promise).rejects.toSatisfy(
        (error) => getNotetakerBotGatewayFailure(error) === "TRANSIENT"
      );

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    });
  });

  describe("requestStop", () => {
    it("POSTs the reason to the stop endpoint with a valid signature", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, accepted: true }, 202));

      await expect(
        buildGateway().requestStop({ sessionId: SESSION_ID, reason: "STOPPED_BY_HOST" })
      ).resolves.toBeUndefined();

      const sent = getSentRequest(fetchFn);
      expect(sent.url).toBe(`https://bot.example.test/v1/sessions/${SESSION_ID}/stop`);
      expect(sent.method).toBe("POST");
      expect(sent.body).toBe('{"reason":"STOPPED_BY_HOST"}');
      expect(
        verifyNotetakerSignature({
          secret: SECRET,
          timestamp: sent.headers.get(NOTETAKER_TIMESTAMP_HEADER),
          signature: sent.headers.get(NOTETAKER_SIGNATURE_HEADER),
          rawBody: sent.body ?? "",
          nowSeconds: NOW_SECONDS,
        })
      ).toBe(true);
    });

    it("resolves on 404", async () => {
      fetchFn.mockResolvedValueOnce(textResponse("", 404));

      await expect(
        buildGateway().requestStop({ sessionId: SESSION_ID, reason: "DISABLED" })
      ).resolves.toBeUndefined();
    });

    it("maps 500 to TRANSIENT", async () => {
      fetchFn.mockResolvedValueOnce(textResponse("", 500));

      const error = await captureError(
        buildGateway().requestStop({ sessionId: SESSION_ID, reason: "DISABLED" })
      );

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });

    it("maps a network error to TRANSIENT", async () => {
      fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));

      const error = await captureError(
        buildGateway().requestStop({ sessionId: SESSION_ID, reason: "DISABLED" })
      );

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });
  });

  describe("getState", () => {
    it("sends a signed GET without a body", async () => {
      fetchFn.mockResolvedValueOnce(
        jsonResponse({ sessionId: SESSION_ID, phase: "IN_MEETING", lastEventSequence: 7 }, 200)
      );

      await buildGateway().getState(SESSION_ID);

      const sent = getSentRequest(fetchFn);
      expect(sent.url).toBe(`https://bot.example.test/v1/sessions/${SESSION_ID}`);
      expect(sent.method).toBe("GET");
      expect(sent.body).toBeUndefined();
      expect(sent.headers.get("Content-Type")).toBeNull();
      const timestamp = sent.headers.get(NOTETAKER_TIMESTAMP_HEADER);
      expect(timestamp).toBe(String(NOW_SECONDS));
      expect(sent.headers.get(NOTETAKER_SIGNATURE_HEADER)).toBe(
        signNotetakerPayload({ secret: SECRET, timestamp: timestamp ?? "", rawBody: "" })
      );
    });

    it("returns the parsed state on 200", async () => {
      const state = { sessionId: SESSION_ID, phase: "IN_MEETING", lastEventSequence: 7 };
      fetchFn.mockResolvedValueOnce(jsonResponse(state, 200));

      await expect(buildGateway().getState(SESSION_ID)).resolves.toEqual(state);
    });

    it("returns null on 404", async () => {
      fetchFn.mockResolvedValueOnce(textResponse("", 404));

      await expect(buildGateway().getState(SESSION_ID)).resolves.toBeNull();
    });

    it("maps 500 to TRANSIENT", async () => {
      fetchFn.mockResolvedValueOnce(textResponse("", 500));

      const error = await captureError(buildGateway().getState(SESSION_ID));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });

    it("maps a network error to TRANSIENT", async () => {
      fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));

      const error = await captureError(buildGateway().getState(SESSION_ID));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });

    it("maps a schema-invalid body to TRANSIENT", async () => {
      fetchFn.mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, phase: "NOPE" }, 200));

      const error = await captureError(buildGateway().getState(SESSION_ID));

      expect(getNotetakerBotGatewayFailure(error)).toBe("TRANSIENT");
    });
  });

  it("URL-encodes the session id in the path", async () => {
    fetchFn.mockResolvedValueOnce(textResponse("", 404));

    await buildGateway().getState("a/b c");

    expect(getSentRequest(fetchFn).url).toBe("https://bot.example.test/v1/sessions/a%2Fb%20c");
  });

  it("never puts the secret or the signature in error messages", async () => {
    fetchFn.mockResolvedValueOnce(textResponse("", 500));
    fetchFn.mockRejectedValueOnce(new TypeError("fetch failed"));

    const statusError = await captureError(buildGateway().requestJoin(buildJoinRequest()));
    const networkError = await captureError(buildGateway().getState(SESSION_ID));

    const signatures = fetchFn.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get(NOTETAKER_SIGNATURE_HEADER)
    );
    for (const error of [statusError, networkError]) {
      if (!(error instanceof Error)) throw new Error("expected an Error");
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain("meet.example.test");
      for (const signature of signatures) {
        expect(signature).toBeTruthy();
        expect(error.message).not.toContain(signature ?? "");
      }
    }
  });
});
