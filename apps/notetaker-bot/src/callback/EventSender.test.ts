// @vitest-environment node
import type { NotetakerBotEvent, NotetakerBotPassage } from "@calcom/lib/notetaker/botContract";
import { notetakerBotEventSchema, verifyNotetakerSignature } from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import type { RecordedRequest, StubHttpServer, StubResponse } from "../testing/httpTestKit";
import { startStubHttpServer, useRealFetch } from "../testing/httpTestKit";
import type { EventSenderDeps, EventSenderStopCause, NotetakerBotEventDraft } from "./EventSender";
import { EventSender } from "./EventSender";

const SECRET = "test-secret-not-real";
const SESSION_ID = "session-under-test";
const CALLBACK_PATH = "/api/notetaker/events";
const START_MS = Date.parse("2030-01-01T10:00:00.000Z");
// Far below the repository-root test timeout, so a sender that never delivers fails on an assertion.
const FLUSH_MS = 3_000;
const SETTLE_MS = 50;

let server: StubHttpServer;
let sender: EventSender | undefined;
let sleeps: number[] = [];
let lines: string[] = [];
let clockMs = START_MS;
let onStopped = vi.fn<(cause: EventSenderStopCause) => void>();

const now = (): number => clockMs;
const nowSeconds = (): number => Math.floor(clockMs / 1000);

const recordingSleep = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};

const hangingSleep = (): Promise<void> => new Promise<void>(() => {});

// A request that would be sent by mistake needs real time to reach the stub server.
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));

const callbackUrl = (): string => `${server.url}${CALLBACK_PATH}`;

const createSender = (overrides: Partial<EventSenderDeps> = {}): EventSender => {
  const created = new EventSender({
    sessionId: SESSION_ID,
    callbackUrl: callbackUrl(),
    secret: SECRET,
    onStopped,
    logger: createLogger({
      level: "debug",
      write: (line) => {
        lines.push(line);
      },
    }),
    sleep: recordingSleep,
    now,
    ...overrides,
  });
  sender = created;
  return created;
};

const answerWith = (statuses: number[]): void => {
  server.respondWith((_request, index) => ({ status: statuses[index] ?? 200 }));
};

const heartbeat = (participantCount = 2): NotetakerBotEventDraft => ({
  type: "session.heartbeat",
  data: { participantCount },
});

const makePassages = (count: number, overrides: Partial<NotetakerBotPassage> = {}): NotetakerBotPassage[] =>
  Array.from({ length: count }, (_unused, index) => ({
    index,
    speakerKey: "speaker-1",
    speakerName: "Test Speaker",
    unknownSpeakerNumber: null,
    startMs: index * 1000,
    endMs: index * 1000 + 500,
    text: `passage ${index}`,
    language: "en",
    ...overrides,
  }));

const passagesDraft = (passages: NotetakerBotPassage[]): NotetakerBotEventDraft => ({
  type: "transcript.passages",
  data: { passages },
});

const requestAt = (index: number): RecordedRequest => {
  const request = server.requests[index];
  if (!request) {
    throw new Error(
      `Expected a recorded request at index ${index}, the stub server has ${server.requests.length}`
    );
  }
  return request;
};

const decode = (request: RecordedRequest): NotetakerBotEvent =>
  notetakerBotEventSchema.parse(JSON.parse(request.rawBody));

const sentEvents = (): NotetakerBotEvent[] => server.requests.map(decode);
const sentSequences = (): number[] => sentEvents().map((event) => event.sequence);

const passageIndexes = (event: NotetakerBotEvent): number[] => {
  if (event.type !== "transcript.passages") {
    throw new Error(`Expected a transcript.passages event, got ${event.type}`);
  }
  return event.data.passages.map((passage) => passage.index);
};

const verifies = (request: RecordedRequest, secret: string, atSeconds: number): boolean =>
  verifyNotetakerSignature({
    secret,
    timestamp: request.headers["x-notetaker-timestamp"],
    signature: request.headers["x-notetaker-signature"],
    rawBody: request.rawBody,
    nowSeconds: atSeconds,
  });

const logRecords = (): Record<string, unknown>[] =>
  lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Expected every log line to be a JSON object, got ${typeof parsed}`);
    }
    return Object.fromEntries(Object.entries(parsed));
  });

const errorRecords = (): Record<string, unknown>[] =>
  logRecords().filter((record) => record.level === "error");

const waitForRequests = (count: number): Promise<void> =>
  vi.waitFor(() => {
    expect(server.requests).toHaveLength(count);
  });

beforeEach(async () => {
  useRealFetch();
  server = await startStubHttpServer();
  sender = undefined;
  sleeps = [];
  lines = [];
  clockMs = START_MS;
  onStopped = vi.fn<(cause: EventSenderStopCause) => void>();
});

afterEach(async () => {
  // Stopping first releases a sender parked in a hung sleep or request before the server goes away.
  sender?.stop();
  await server.close();
  vi.unstubAllGlobals();
});

describe("EventSender", () => {
  describe("envelope", () => {
    it("posts each draft to the callback URL with consecutive sequences and distinct event ids", async () => {
      const eventSender = createSender();

      eventSender.enqueue({ type: "session.join_requested", data: {} });
      eventSender.enqueue({ type: "session.admitted", data: {} });
      eventSender.enqueue(heartbeat(4));
      await eventSender.flush(FLUSH_MS);

      expect(server.requests).toHaveLength(3);
      for (const request of server.requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe(CALLBACK_PATH);
        expect(request.headers["content-type"]).toBe("application/json");
      }

      const events = sentEvents();
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.type)).toEqual([
        "session.join_requested",
        "session.admitted",
        "session.heartbeat",
      ]);
      expect(events.map((event) => event.sessionId)).toEqual([SESSION_ID, SESSION_ID, SESSION_ID]);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
      expect(events[2]?.data).toEqual({ participantCount: 4 });
    });

    it("stamps occurredAt with the clock at enqueue time, not at send time", async () => {
      const eventSender = createSender();

      eventSender.enqueue(heartbeat());
      clockMs = START_MS + 90_000;
      eventSender.enqueue(heartbeat());
      clockMs = START_MS + 180_000;
      await eventSender.flush(FLUSH_MS);

      expect(sentEvents().map((event) => event.occurredAt)).toEqual([
        "2030-01-01T10:00:00.000Z",
        "2030-01-01T10:01:30.000Z",
      ]);
    });

    it("keeps occurredAt unchanged when the event is retried later", async () => {
      server.respondWith((_request, index) => {
        if (index > 0) return { status: 200 };
        clockMs = START_MS + 120_000;
        return { status: 500 };
      });
      const eventSender = createSender();

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(sentEvents().map((event) => event.occurredAt)).toEqual([
        "2030-01-01T10:00:00.000Z",
        "2030-01-01T10:00:00.000Z",
      ]);
    });
  });

  describe("signature", () => {
    it("signs every request with the shared secret", async () => {
      const eventSender = createSender();

      eventSender.enqueue(heartbeat());
      eventSender.enqueue(passagesDraft(makePassages(2)));
      eventSender.enqueue({ type: "session.notice_posted", data: {} });
      await eventSender.flush(FLUSH_MS);

      expect(server.requests).toHaveLength(3);
      for (const request of server.requests) {
        expect(request.headers["x-notetaker-timestamp"]).toBe(String(nowSeconds()));
        expect(request.headers["x-notetaker-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(verifies(request, SECRET, nowSeconds())).toBe(true);
        expect(verifies(request, "another-secret-not-real", nowSeconds())).toBe(false);
      }
    });

    it("signs each attempt again with the current time over the same body", async () => {
      // The jump is larger than the signature tolerance: a retry carrying the first timestamp would be refused.
      const laterMs = START_MS + 600_000;
      server.respondWith((_request, index) => {
        if (index > 0) return { status: 200 };
        clockMs = laterMs;
        return { status: 500 };
      });
      const eventSender = createSender();

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(server.requests).toHaveLength(2);
      const first = requestAt(0);
      const second = requestAt(1);
      const startSeconds = Math.floor(START_MS / 1000);
      const laterSeconds = Math.floor(laterMs / 1000);

      expect(second.rawBody).toBe(first.rawBody);
      expect(first.headers["x-notetaker-timestamp"]).toBe(String(startSeconds));
      expect(second.headers["x-notetaker-timestamp"]).toBe(String(laterSeconds));
      expect(second.headers["x-notetaker-signature"]).not.toBe(first.headers["x-notetaker-signature"]);
      expect(verifies(first, SECRET, startSeconds)).toBe(true);
      expect(verifies(second, SECRET, laterSeconds)).toBe(true);
      expect(verifies(first, SECRET, laterSeconds)).toBe(false);
    });
  });

  describe("retries", () => {
    it("retries the same event after a 5xx answer before sending the next one", async () => {
      answerWith([500, 500, 200, 200]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 1, 1, 2]);
      expect(requestAt(1).rawBody).toBe(requestAt(0).rawBody);
      expect(requestAt(2).rawBody).toBe(requestAt(0).rawBody);
      expect(sleeps).toEqual([1000, 2000]);
      expect(eventSender.lastAcceptedSequence).toBe(2);
    });

    it("doubles the backoff up to the configured maximum", async () => {
      answerWith([500, 500, 500, 500, 500, 200]);
      const eventSender = createSender({ retry: { baseDelayMs: 100, maxDelayMs: 400 } });

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 1, 1, 1, 1, 1]);
      expect(sleeps).toEqual([100, 200, 400, 400, 400]);
    });

    it("restarts the backoff at the base delay for each event", async () => {
      answerWith([500, 500, 200, 500, 200]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 1, 1, 2, 2]);
      expect(sleeps).toEqual([1000, 2000, 1000]);
    });

    it("retries after a network error without skipping the event", async () => {
      let calls = 0;
      const fetchFn: typeof fetch = (input, init) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
        return fetch(input, init);
      };
      const eventSender = createSender({ fetchFn });

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(calls).toBe(3);
      expect(sleeps).toEqual([1000]);
      expect(sentSequences()).toEqual([1, 2]);
      expect(eventSender.lastAcceptedSequence).toBe(2);
      expect(onStopped).not.toHaveBeenCalled();
    });

    it("retries when the callback does not answer within the request timeout", async () => {
      server.respondWith((_request, index) => {
        if (index === 0) return new Promise<StubResponse>(() => {});
        return { status: 200 };
      });
      const eventSender = createSender({ requestTimeoutMs: 50 });

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 1, 2]);
      expect(requestAt(1).rawBody).toBe(requestAt(0).rawBody);
      expect(sleeps).toEqual([1000]);
      expect(eventSender.lastAcceptedSequence).toBe(2);
    });

    it("retries every status it has no rule for, redirects included", async () => {
      answerWith([503, 404, 302, 200, 200]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 1, 1, 1, 2]);
      expect(sleeps).toEqual([1000, 2000, 4000]);
      expect(errorRecords()).toEqual([]);
      expect(onStopped).not.toHaveBeenCalled();
      expect(eventSender.isStopped).toBe(false);
    });
  });

  describe("accepted events", () => {
    it("advances lastAcceptedSequence with each 2xx answer and empties the queue", async () => {
      const eventSender = createSender();
      expect(eventSender.lastAcceptedSequence).toBe(0);
      expect(eventSender.pendingCount).toBe(0);
      expect(eventSender.isStopped).toBe(false);

      eventSender.enqueue(heartbeat(1));
      expect(eventSender.pendingCount).toBe(1);
      await eventSender.flush(FLUSH_MS);
      expect(eventSender.lastAcceptedSequence).toBe(1);
      expect(eventSender.pendingCount).toBe(0);

      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);
      expect(eventSender.lastAcceptedSequence).toBe(2);
      expect(eventSender.pendingCount).toBe(0);
      expect(sleeps).toEqual([]);
    });

    it("counts the event being sent in pendingCount", () => {
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      eventSender.enqueue(heartbeat(3));

      expect(eventSender.pendingCount).toBe(3);
    });
  });

  describe("rejected events", () => {
    it("drops an event answered with 400, logs it once and sends the next one", async () => {
      answerWith([200, 400, 200]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue({ type: "session.reconnecting", data: { atMs: 1500 } });
      eventSender.enqueue(heartbeat(3));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 2, 3]);
      expect(sleeps).toEqual([]);
      expect(eventSender.lastAcceptedSequence).toBe(3);
      expect(eventSender.pendingCount).toBe(0);
      expect(onStopped).not.toHaveBeenCalled();
      expect(errorRecords()).toEqual([
        {
          level: "error",
          time: expect.any(String),
          message: expect.any(String),
          sessionId: SESSION_ID,
          type: "session.reconnecting",
          sequence: 2,
          status: 400,
        },
      ]);
    });

    it("does not count a dropped event as accepted", async () => {
      answerWith([200, 400]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1, 2]);
      expect(eventSender.lastAcceptedSequence).toBe(1);
      expect(eventSender.pendingCount).toBe(0);
    });

    it("drops an event answered with a single 401 and carries on", async () => {
      answerWith([401, 200]);
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2]);
      expect(sleeps).toEqual([]);
      expect(eventSender.lastAcceptedSequence).toBe(2);
      expect(eventSender.isStopped).toBe(false);
      expect(onStopped).not.toHaveBeenCalled();
      expect(errorRecords()).toEqual([
        {
          level: "error",
          time: expect.any(String),
          message: expect.any(String),
          sessionId: SESSION_ID,
          type: "session.heartbeat",
          sequence: 1,
          status: 401,
        },
      ]);
    });
  });

  describe("repeated 401", () => {
    it("stops for good after three consecutive 401 answers", async () => {
      server.respondWith(() => ({ status: 401 }));
      const eventSender = createSender();

      for (let count = 1; count <= 5; count += 1) {
        eventSender.enqueue(heartbeat(count));
      }
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2, 3]);
      expect(sleeps).toEqual([]);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(onStopped).toHaveBeenCalledWith("UNAUTHORIZED");
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);
      expect(eventSender.lastAcceptedSequence).toBe(0);
    });

    it("honours a configured number of consecutive 401 answers", async () => {
      server.respondWith(() => ({ status: 401 }));
      const eventSender = createSender({ maxConsecutiveUnauthorized: 2 });

      for (let count = 1; count <= 5; count += 1) {
        eventSender.enqueue(heartbeat(count));
      }
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2]);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(onStopped).toHaveBeenCalledWith("UNAUTHORIZED");
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);
    });

    it("keeps going when an accepted event separates the 401 answers", async () => {
      answerWith([401, 401, 200, 401, 401, 200]);
      const eventSender = createSender();

      for (let count = 1; count <= 6; count += 1) {
        eventSender.enqueue(heartbeat(count));
      }
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(eventSender.lastAcceptedSequence).toBe(6);
      expect(eventSender.isStopped).toBe(false);
      expect(onStopped).not.toHaveBeenCalled();
    });

    it("resets the count on any other answer, a refused or failed one included", async () => {
      answerWith([401, 401, 400, 401, 401, 500, 401, 401, 200]);
      const eventSender = createSender();

      for (let count = 1; count <= 8; count += 1) {
        eventSender.enqueue(heartbeat(count));
      }
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2, 3, 4, 5, 6, 6, 7, 8]);
      expect(sleeps).toEqual([1000]);
      expect(eventSender.lastAcceptedSequence).toBe(8);
      expect(eventSender.isStopped).toBe(false);
      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  describe("410", () => {
    it("stops for good, drops the queue and reports the cause once", async () => {
      answerWith([200, 410]);
      const eventSender = createSender();

      for (let count = 1; count <= 4; count += 1) {
        eventSender.enqueue(heartbeat(count));
      }
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 2]);
      expect(sleeps).toEqual([]);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(onStopped).toHaveBeenCalledWith("GONE");
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);
      expect(eventSender.lastAcceptedSequence).toBe(1);

      await eventSender.flush();

      server.respondWith(() => ({ status: 200 }));
      eventSender.enqueue(heartbeat(5));
      expect(eventSender.pendingCount).toBe(0);
      await eventSender.flush(FLUSH_MS);
      await settle();
      expect(server.requests).toHaveLength(2);

      eventSender.stop();
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(eventSender.isStopped).toBe(true);
    });
  });

  describe("batching of passages", () => {
    it("splits 120 passages into events of 50, 50 and 20 in order", async () => {
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft(makePassages(120)));
      expect(eventSender.pendingCount).toBe(3);
      await eventSender.flush(FLUSH_MS);

      const events = sentEvents();
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => passageIndexes(event).length)).toEqual([50, 50, 20]);
      expect(events.flatMap(passageIndexes)).toEqual(Array.from({ length: 120 }, (_unused, index) => index));
      expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    });

    it("sends exactly 50 passages as one event", async () => {
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft(makePassages(50)));
      await eventSender.flush(FLUSH_MS);

      expect(sentEvents().map((event) => passageIndexes(event).length)).toEqual([50]);
    });

    it("sends 51 passages as two events", async () => {
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft(makePassages(51)));
      await eventSender.flush(FLUSH_MS);

      const events = sentEvents();
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(events.map((event) => passageIndexes(event).length)).toEqual([50, 1]);
      expect(passageIndexes(events[1] ?? decode(requestAt(1)))).toEqual([50]);
    });

    it("sends nothing and uses no sequence for an empty list of passages", async () => {
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft([]));
      expect(eventSender.pendingCount).toBe(0);
      await eventSender.flush(FLUSH_MS);
      await settle();
      expect(server.requests).toHaveLength(0);

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1]);
      expect(errorRecords()).toEqual([]);
    });

    it("continues the sequence of a later draft after a split", async () => {
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft(makePassages(120)));
      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      const events = sentEvents();
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      expect(events.map((event) => event.type)).toEqual([
        "transcript.passages",
        "transcript.passages",
        "transcript.passages",
        "session.heartbeat",
      ]);
    });
  });

  describe("validation at enqueue", () => {
    it("never posts an event the contract refuses and logs it without its content", async () => {
      const marker = "MARKER-OVERLONG-TEXT";
      const overlongText = marker.padEnd(1001, "x");
      const eventSender = createSender();

      eventSender.enqueue(passagesDraft(makePassages(1, { text: overlongText })));
      expect(eventSender.pendingCount).toBe(0);
      await eventSender.flush(FLUSH_MS);
      await settle();
      expect(server.requests).toHaveLength(0);

      const errors = errorRecords();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ sessionId: SESSION_ID, type: "transcript.passages", sequence: 1 })
      );
      expect(JSON.stringify(errors[0])).toContain("data.passages.0.text:too_big");
      for (const line of lines) {
        expect(line).not.toContain(marker);
        expect(line).not.toContain("xxxxxxxx");
      }

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(sentSequences()).toEqual([1]);
      expect(eventSender.lastAcceptedSequence).toBe(1);
    });
  });

  describe("flush", () => {
    it("resolves at once on a sender that has nothing to send", async () => {
      const eventSender = createSender();

      await eventSender.flush();
      await eventSender.flush(FLUSH_MS);

      expect(server.requests).toHaveLength(0);
      expect(eventSender.pendingCount).toBe(0);
    });

    it("resolves once the queue is empty", async () => {
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      await eventSender.flush(FLUSH_MS);

      expect(eventSender.pendingCount).toBe(0);
      expect(sentSequences()).toEqual([1, 2]);
    });

    it("resolves after the timeout while the event still cannot be delivered", async () => {
      server.respondWith(() => ({ status: 500 }));
      const eventSender = createSender({ sleep: hangingSleep });

      eventSender.enqueue(heartbeat());
      const startedAt = Date.now();
      await eventSender.flush(30);
      const elapsedMs = Date.now() - startedAt;

      // Timers may fire a little early, hence the margin under the 30 ms asked for.
      expect(elapsedMs).toBeGreaterThanOrEqual(20);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(eventSender.pendingCount).toBe(1);
      expect(eventSender.isStopped).toBe(false);
      expect(eventSender.lastAcceptedSequence).toBe(0);
    });

    it("resolves when the sender is stopped during the wait", async () => {
      server.respondWith(() => ({ status: 500 }));
      const eventSender = createSender({ sleep: hangingSleep });

      eventSender.enqueue(heartbeat());
      await waitForRequests(1);
      const startedAt = Date.now();
      const flushed = eventSender.flush(FLUSH_MS);
      setTimeout(() => eventSender.stop(), 20);
      await flushed;

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);
    });

    it("resolves when a 410 stops the sender during the wait", async () => {
      server.respondWith(() => ({ status: 410 }));
      const eventSender = createSender();

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      const startedAt = Date.now();
      await eventSender.flush(FLUSH_MS);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);
    });
  });

  describe("stop", () => {
    it("drops the queue and sends nothing more, without reporting a cause", async () => {
      server.respondWith(() => ({ status: 500 }));
      const eventSender = createSender({ sleep: hangingSleep });

      eventSender.enqueue(heartbeat(1));
      eventSender.enqueue(heartbeat(2));
      eventSender.enqueue(heartbeat(3));
      await waitForRequests(1);
      expect(eventSender.pendingCount).toBe(3);

      eventSender.stop();
      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.pendingCount).toBe(0);

      server.respondWith(() => ({ status: 200 }));
      eventSender.enqueue(heartbeat(4));
      expect(eventSender.pendingCount).toBe(0);
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(server.requests).toHaveLength(1);
      expect(eventSender.lastAcceptedSequence).toBe(0);
      expect(onStopped).not.toHaveBeenCalled();
    });

    it("can be called more than once", async () => {
      const eventSender = createSender();

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);
      eventSender.stop();
      eventSender.stop();
      await settle();

      expect(eventSender.isStopped).toBe(true);
      expect(eventSender.lastAcceptedSequence).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(onStopped).not.toHaveBeenCalled();
    });
  });

  describe("default fetch", () => {
    it("looks the global fetch up on every attempt instead of capturing it at construction", async () => {
      const eventSender = new EventSender({
        sessionId: SESSION_ID,
        callbackUrl: callbackUrl(),
        secret: SECRET,
        onStopped,
        logger: createLogger({ level: "silent", write: () => {} }),
        sleep: recordingSleep,
        now,
      });
      sender = eventSender;
      const spy = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", spy);

      eventSender.enqueue(heartbeat());
      await eventSender.flush(FLUSH_MS);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(0);
      expect(eventSender.lastAcceptedSequence).toBe(1);

      const [input, init] = spy.mock.calls[0] ?? [];
      expect(String(input)).toBe(callbackUrl());
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
    });
  });

  describe("logging", () => {
    it("never writes the secret, a signature, an event id or any transcript content", async () => {
      const markerText = "MARKER-PASSAGE-TEXT";
      const markerName = "MARKER-SPEAKER-NAME";
      const markedPassages = (): NotetakerBotPassage[] =>
        makePassages(2, { text: markerText, speakerName: markerName });
      answerWith([500, 400, 401, 410]);
      const eventSender = createSender();

      eventSender.enqueue(
        passagesDraft(makePassages(1, { text: markerText.padEnd(1001, "x"), speakerName: markerName }))
      );
      eventSender.enqueue(passagesDraft(markedPassages()));
      eventSender.enqueue(passagesDraft(markedPassages()));
      eventSender.enqueue(passagesDraft(markedPassages()));
      eventSender.enqueue(passagesDraft(markedPassages()));
      await eventSender.flush(FLUSH_MS);
      await settle();

      expect(sentSequences()).toEqual([1, 1, 2, 3]);
      expect(onStopped).toHaveBeenCalledWith("GONE");
      // One line for the refused draft, one for the 400 and one for the 401 at the very least.
      expect(errorRecords().length).toBeGreaterThanOrEqual(3);

      const forbidden = [
        SECRET,
        "sha256=",
        markerText,
        markerName,
        ...sentEvents().map((event) => event.eventId),
        ...server.requests.map((request) => request.headers["x-notetaker-signature"] ?? "sha256="),
      ];
      for (const line of lines) {
        for (const value of forbidden) {
          expect(line).not.toContain(value);
        }
      }
      for (const record of logRecords()) {
        expect(record.sessionId).toBe(SESSION_ID);
      }
    });
  });
});
