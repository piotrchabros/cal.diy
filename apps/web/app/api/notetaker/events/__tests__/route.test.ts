import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "@calcom/features/notetaker/lib/tasker/types";
import type { NotetakerSessionUpdateInput } from "@calcom/features/notetaker/repositories/interfaces/INotetakerSessionRepository";
import { NotetakerSessionEventService } from "@calcom/features/notetaker/services/NotetakerSessionEventService";
import type { InMemoryBookingSeed } from "@calcom/features/notetaker/tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "@calcom/features/notetaker/tests/InMemoryNotetakerRepositories";
import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerBotEvent, NotetakerBotPassage } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const harness = vi.hoisted(() => ({
  getService: vi.fn<() => NotetakerSessionEventService>(),
  captureException: vi.fn(),
}));

// Mocking the container keeps the Prisma repositories from loading; the real service runs on in-memory fakes.
vi.mock("@calcom/features/notetaker/di/NotetakerSessionEventService.container", () => ({
  getNotetakerSessionEventService: harness.getService,
}));

vi.mock("@sentry/nextjs", () => ({ captureException: harness.captureException }));

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;

const SECRET = "test-notetaker-bot-secret";
const NOW = new Date("2026-10-12T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const OCCURRED_AT = "2026-10-12T10:05:00.000Z";
const ADMITTED_AT = new Date("2026-10-12T10:01:00.000Z");
const EVENTS_URL = "http://localhost/api/notetaker/events";
const SEEDED_SEQUENCE = 3;
const FRESH_SEQUENCE = 4;
const UNKNOWN_SESSION_ID = "00000000-0000-4000-8000-ffffffffffff";
const EVENT_ID = "00000000-0000-4000-8000-0000000000aa";
const PASSAGE_TEXT = "confidential-passage-text";

const INVALID_SIGNATURE_BODY = { message: "Invalid signature" };
const INVALID_EVENT_BODY = { message: "Invalid event" };
const GONE_BODY = { message: "Session is gone" };
const OK_BODY = { ok: true };

function buildBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: BOOKING_UID,
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime: new Date("2026-10-12T10:00:00.000Z"),
    endTime: new Date("2026-10-12T10:30:00.000Z"),
    title: "Planning call",
    location: null,
    metadata: null,
    recurringEventId: null,
    eventTypeId: 10,
    attendeeEmails: ["attendee@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

class RecordingTasker implements INotetakerTasker {
  finalizeCalls: NotetakerFinalizeSessionPayload[] = [];
  summaryCalls: NotetakerGenerateSummaryPayload[] = [];
  notificationCalls: NotetakerSendNotificationPayload[] = [];
  finalizeResult = { runId: "run-1" };

  async finalizeSession(payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    this.finalizeCalls.push(payload);
    return this.finalizeResult;
  }

  async generateSummary(payload: NotetakerGenerateSummaryPayload): Promise<{ runId: string }> {
    this.summaryCalls.push(payload);
    return { runId: "summary-run" };
  }

  async sendNotification(payload: NotetakerSendNotificationPayload): Promise<{ runId: string }> {
    this.notificationCalls.push(payload);
    return { runId: "notification-run" };
  }
}

function passage(index: number, text = PASSAGE_TEXT): NotetakerBotPassage {
  return {
    index,
    speakerKey: "speaker-1",
    speakerName: "Alice",
    unknownSpeakerNumber: null,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text,
    language: "en",
  };
}

function passages(count: number): NotetakerBotPassage[] {
  return Array.from({ length: count }, (_, index) => passage(index));
}

function envelope(
  sessionId: string,
  sequence: number
): { eventId: string; sessionId: string; sequence: number; occurredAt: string } {
  return { eventId: EVENT_ID, sessionId, sequence, occurredAt: OCCURRED_AT };
}

function joinRequested(sessionId: string, sequence: number): NotetakerBotEvent {
  return { ...envelope(sessionId, sequence), type: "session.join_requested", data: {} };
}

function heartbeat(sessionId: string, sequence: number): NotetakerBotEvent {
  return { ...envelope(sessionId, sequence), type: "session.heartbeat", data: { participantCount: 2 } };
}

function passagesEvent(
  sessionId: string,
  sequence: number,
  eventPassages: NotetakerBotPassage[]
): NotetakerBotEvent {
  return {
    ...envelope(sessionId, sequence),
    type: "transcript.passages",
    data: { passages: eventPassages },
  };
}

function ended(sessionId: string, sequence: number): NotetakerBotEvent {
  return {
    ...envelope(sessionId, sequence),
    type: "session.ended",
    data: { endReason: "MEETING_ENDED", durationMs: 60_000, interruptedAtMs: null, passageCount: 3 },
  };
}

function buildRequest(rawBody: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(EVENTS_URL, { method: "POST", body: rawBody, headers });
}

function signedHeaders(
  rawBody: string,
  overrides: { secret?: string; timestamp?: number } = {}
): Record<string, string> {
  const timestamp = String(overrides.timestamp ?? NOW_SECONDS);
  return {
    [NOTETAKER_TIMESTAMP_HEADER]: timestamp,
    [NOTETAKER_SIGNATURE_HEADER]: signNotetakerPayload({
      secret: overrides.secret ?? SECRET,
      timestamp,
      rawBody,
    }),
  };
}

// A request body can be read once, so every call builds a new request, including a replay.
function post(rawBody: string, headers: Record<string, string>): Promise<Response> {
  return POST(buildRequest(rawBody, headers), { params: Promise.resolve({}) });
}

function postEvent(body: unknown): Promise<Response> {
  const rawBody = JSON.stringify(body);
  return post(rawBody, signedHeaders(rawBody));
}

async function readResponse(response: Response): Promise<{ status: number; text: string; body: unknown }> {
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  return { status: response.status, text, body };
}

function serializeCalls(calls: unknown[][]): string {
  return calls
    .flat()
    .map((argument) =>
      argument instanceof Error ? `${argument.message}\n${argument.stack}` : JSON.stringify(argument)
    )
    .join("\n");
}

describe("POST /api/notetaker/events", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let tasker: RecordingTasker;
  let logger: ISimpleLogger;

  beforeEach(() => {
    // Only Date is faked: the signature check reads the clock, and request.text() needs real timers.
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubEnv("NOTETAKER_BOT_SECRET", SECRET);
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addBooking(buildBooking());
    tasker = new RecordingTasker();
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    harness.getService.mockReturnValue(
      new NotetakerSessionEventService({
        sessionRepository: repositories.sessionRepository,
        transcriptRepository: repositories.transcriptRepository,
        notetakerTasker: tasker,
        logger,
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    harness.getService.mockReset();
    harness.captureException.mockReset();
  });

  async function seedSession(patch: NotetakerSessionUpdateInput = {}): Promise<string> {
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Cal.diy Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
    });
    await repositories.sessionRepository.update(session.id, patch);
    return session.id;
  }

  function seedTranscribing(patch: NotetakerSessionUpdateInput = {}): Promise<string> {
    return seedSession({
      status: "TRANSCRIBING",
      admittedAt: ADMITTED_AT,
      lastEventSequence: SEEDED_SEQUENCE,
      ...patch,
    });
  }

  function sessionOf(sessionId: string) {
    const session = repositories.store.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} is missing from the store`);
    return { ...session };
  }

  function storedPassageCount(sessionId: string): number {
    const transcript = Array.from(repositories.store.transcripts.values()).find(
      (candidate) => candidate.sessionId === sessionId
    );
    if (!transcript) return 0;
    return repositories.store.passages.get(transcript.id)?.size ?? 0;
  }

  function loggedOutput(): string {
    return [logger.debug, logger.info, logger.warn, logger.error]
      .map((fn) => serializeCalls(vi.mocked(fn).mock.calls))
      .join("\n");
  }

  describe("signature (401)", () => {
    async function expectRejectedSignature(
      send: (rawBody: string) => Promise<Response>,
      sessionId: string
    ): Promise<void> {
      const before = sessionOf(sessionId);

      const response = await readResponse(await send(JSON.stringify(heartbeat(sessionId, FRESH_SEQUENCE))));

      expect(response.status).toBe(401);
      expect(response.body).toEqual(INVALID_SIGNATURE_BODY);
      expect(harness.getService).not.toHaveBeenCalled();
      expect(sessionOf(sessionId)).toEqual(before);
    }

    it("rejects a body signed with a different secret", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) => post(rawBody, signedHeaders(rawBody, { secret: "another-secret" })),
        sessionId
      );
    });

    it("rejects a well-formed signature with the wrong value", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) =>
          post(rawBody, {
            ...signedHeaders(rawBody),
            [NOTETAKER_SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}`,
          }),
        sessionId
      );
    });

    it("rejects a signature without the sha256= prefix", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature((rawBody) => {
        const headers = signedHeaders(rawBody);
        return post(rawBody, {
          ...headers,
          [NOTETAKER_SIGNATURE_HEADER]: headers[NOTETAKER_SIGNATURE_HEADER].replace("sha256=", ""),
        });
      }, sessionId);
    });

    it("rejects a request without the signature header", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) =>
          post(rawBody, {
            [NOTETAKER_TIMESTAMP_HEADER]: signedHeaders(rawBody)[NOTETAKER_TIMESTAMP_HEADER],
          }),
        sessionId
      );
    });

    it("rejects a request without the timestamp header", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) =>
          post(rawBody, {
            [NOTETAKER_SIGNATURE_HEADER]: signedHeaders(rawBody)[NOTETAKER_SIGNATURE_HEADER],
          }),
        sessionId
      );
    });

    it("rejects a request without both headers", async () => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature((rawBody) => post(rawBody, {}), sessionId);
    });

    it.each([
      ["301 seconds in the past", NOW_SECONDS - 301],
      ["301 seconds in the future", NOW_SECONDS + 301],
    ])("rejects a correctly signed timestamp %s", async (_name, timestamp) => {
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) => post(rawBody, signedHeaders(rawBody, { timestamp })),
        sessionId
      );
    });

    it("accepts a timestamp exactly 300 seconds old", async () => {
      const sessionId = await seedTranscribing();
      const rawBody = JSON.stringify(heartbeat(sessionId, FRESH_SEQUENCE));

      const response = await readResponse(
        await post(rawBody, signedHeaders(rawBody, { timestamp: NOW_SECONDS - 300 }))
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(OK_BODY);
    });

    it("rejects a body signed with the empty string when the secret is unset", async () => {
      vi.stubEnv("NOTETAKER_BOT_SECRET", "");
      const sessionId = await seedTranscribing();

      await expectRejectedSignature(
        (rawBody) => post(rawBody, signedHeaders(rawBody, { secret: "" })),
        sessionId
      );
    });

    it("rejects a body whose bytes differ from the signed ones", async () => {
      const sessionId = await seedTranscribing();
      const event = heartbeat(sessionId, FRESH_SEQUENCE);

      await expectRejectedSignature(
        (rawBody) => post(JSON.stringify(event, null, 2), signedHeaders(rawBody)),
        sessionId
      );
    });

    it("accepts a pretty-printed body signed as sent", async () => {
      const sessionId = await seedTranscribing();
      const rawBody = JSON.stringify(heartbeat(sessionId, FRESH_SEQUENCE), null, 2);

      const response = await readResponse(await post(rawBody, signedHeaders(rawBody)));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(OK_BODY);
      expect(sessionOf(sessionId).lastEventSequence).toBe(FRESH_SEQUENCE);
    });
  });

  describe("schema (400)", () => {
    async function expectInvalidEvent(pending: Promise<Response>): Promise<void> {
      const response = await readResponse(await pending);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(INVALID_EVENT_BODY);
      expect(response.text).not.toContain(PASSAGE_TEXT);
      expect(harness.getService).not.toHaveBeenCalled();
    }

    it("rejects a body that is not JSON", async () => {
      const rawBody = "not json";

      await expectInvalidEvent(post(rawBody, signedHeaders(rawBody)));
    });

    it("rejects a heartbeat without participantCount", async () => {
      const sessionId = await seedTranscribing();

      await expectInvalidEvent(postEvent({ ...heartbeat(sessionId, FRESH_SEQUENCE), data: {} }));
    });

    it("rejects an unknown event type", async () => {
      const sessionId = await seedTranscribing();

      await expectInvalidEvent(
        postEvent({ ...passagesEvent(sessionId, FRESH_SEQUENCE, [passage(0)]), type: "session.unknown" })
      );
    });

    it("rejects sequence 0", async () => {
      const sessionId = await seedTranscribing();

      await expectInvalidEvent(postEvent(passagesEvent(sessionId, 0, [passage(0)])));
    });

    it("rejects a passage longer than 1,000 characters", async () => {
      const sessionId = await seedTranscribing();

      await expectInvalidEvent(
        postEvent(passagesEvent(sessionId, FRESH_SEQUENCE, [passage(0, "x".repeat(1001))]))
      );
      expect(storedPassageCount(sessionId)).toBe(0);
    });

    it("rejects more than 50 passages", async () => {
      const sessionId = await seedTranscribing();

      await expectInvalidEvent(postEvent(passagesEvent(sessionId, FRESH_SEQUENCE, passages(51))));
      expect(storedPassageCount(sessionId)).toBe(0);
    });

    it("accepts a 1,000-character passage and a 50-passage event", async () => {
      const sessionId = await seedTranscribing();

      const longPassage = await readResponse(
        await postEvent(passagesEvent(sessionId, FRESH_SEQUENCE, [passage(100, "x".repeat(1000))]))
      );
      const fullBatch = await readResponse(
        await postEvent(passagesEvent(sessionId, FRESH_SEQUENCE + 1, passages(50)))
      );

      expect(longPassage.status).toBe(200);
      expect(longPassage.body).toEqual(OK_BODY);
      expect(fullBatch.status).toBe(200);
      expect(fullBatch.body).toEqual(OK_BODY);
      expect(storedPassageCount(sessionId)).toBe(51);
    });
  });

  describe("gone (410)", () => {
    it("answers 410 for an unknown session", async () => {
      const response = await readResponse(await postEvent(heartbeat(UNKNOWN_SESSION_ID, 1)));

      expect(response.status).toBe(410);
      expect(response.body).toEqual(GONE_BODY);
      expect(repositories.store.sessions.size).toBe(0);
      expect(tasker.finalizeCalls).toEqual([]);
    });

    it("answers 410 for passages sent to a PROCESSING session and stores none", async () => {
      const sessionId = await seedSession({
        status: "PROCESSING",
        admittedAt: ADMITTED_AT,
        lastEventSequence: SEEDED_SEQUENCE,
      });
      const before = sessionOf(sessionId);

      const response = await readResponse(
        await postEvent(passagesEvent(sessionId, FRESH_SEQUENCE, [passage(0), passage(1)]))
      );

      expect(response.status).toBe(410);
      expect(response.body).toEqual(GONE_BODY);
      expect(sessionOf(sessionId)).toEqual(before);
      expect(storedPassageCount(sessionId)).toBe(0);
      expect(tasker.finalizeCalls).toEqual([]);
    });

    it.each<NotetakerSessionStatusDto>([
      "READY",
      "ENDED_EARLY",
      "FAILED",
    ])("answers 410 for a fresh event on a %s session", async (status) => {
      const sessionId = await seedTranscribing({ status });
      const before = sessionOf(sessionId);

      const response = await readResponse(await postEvent(heartbeat(sessionId, FRESH_SEQUENCE)));

      expect(response.status).toBe(410);
      expect(response.body).toEqual(GONE_BODY);
      expect(sessionOf(sessionId)).toEqual(before);
      expect(tasker.finalizeCalls).toEqual([]);
    });
  });

  describe("accepted (200)", () => {
    it("stores an accepted event once and answers 200 again for its replay", async () => {
      const sessionId = await seedTranscribing();
      const rawBody = JSON.stringify(passagesEvent(sessionId, FRESH_SEQUENCE, [passage(0), passage(1)]));
      const headers = signedHeaders(rawBody);

      const first = await readResponse(await post(rawBody, headers));

      expect(first.status).toBe(200);
      expect(first.body).toEqual(OK_BODY);
      expect(storedPassageCount(sessionId)).toBe(2);
      expect(sessionOf(sessionId).lastEventSequence).toBe(FRESH_SEQUENCE);

      const replay = await readResponse(await post(rawBody, headers));

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(OK_BODY);
      expect(storedPassageCount(sessionId)).toBe(2);
      expect(sessionOf(sessionId).lastEventSequence).toBe(FRESH_SEQUENCE);
    });

    it("applies the status change of an accepted event", async () => {
      const sessionId = await seedSession();

      const response = await readResponse(await postEvent(joinRequested(sessionId, 1)));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(OK_BODY);
      expect(sessionOf(sessionId).status).toBe("WAITING_TO_BE_ADMITTED");
    });
  });

  describe("order of checks", () => {
    it("checks the signature before the schema", async () => {
      const rawBody = JSON.stringify({ ...heartbeat(UNKNOWN_SESSION_ID, 0), type: "session.unknown" });

      const response = await readResponse(
        await post(rawBody, signedHeaders(rawBody, { secret: "another-secret" }))
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual(INVALID_SIGNATURE_BODY);
    });

    it("checks the schema before the session", async () => {
      const response = await readResponse(await postEvent(heartbeat(UNKNOWN_SESSION_ID, 0)));

      expect(response.status).toBe(400);
      expect(response.body).toEqual(INVALID_EVENT_BODY);
      expect(harness.getService).not.toHaveBeenCalled();
    });

    it("checks the session before the sequence", async () => {
      const response = await readResponse(await postEvent(heartbeat(UNKNOWN_SESSION_ID, 1)));

      expect(response.status).toBe(410);
      expect(response.body).toEqual(GONE_BODY);
    });

    it.each<NotetakerSessionStatusDto>([
      "PROCESSING",
      "READY",
    ])("checks the sequence before the status of a %s session", async (status) => {
      const sessionId = await seedSession({ status, admittedAt: ADMITTED_AT, lastEventSequence: 5 });
      const before = sessionOf(sessionId);

      const duplicate = await readResponse(await postEvent(heartbeat(sessionId, 5)));
      const fresh = await readResponse(await postEvent(heartbeat(sessionId, 6)));

      expect(duplicate.status).toBe(200);
      expect(duplicate.body).toEqual(OK_BODY);
      expect(fresh.status).toBe(410);
      expect(fresh.body).toEqual(GONE_BODY);
      expect(sessionOf(sessionId)).toEqual(before);
      expect(tasker.finalizeCalls).toEqual([]);
    });
  });

  describe("server error (5xx)", () => {
    it("answers 500 when the finalize enqueue fails, without leaking the secret or the body", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      tasker.finalizeResult = { runId: "task-failed" };
      const sessionId = await seedTranscribing();
      const rawBody = JSON.stringify(ended(sessionId, FRESH_SEQUENCE));

      const response = await post(rawBody, signedHeaders(rawBody));
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(rawBody);
      expect(harness.captureException).toHaveBeenCalledTimes(1);
    });

    it("answers 200 and enqueues finalize again when the bot retries the failed request", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      tasker.finalizeResult = { runId: "task-failed" };
      const sessionId = await seedTranscribing();
      const rawBody = JSON.stringify(ended(sessionId, FRESH_SEQUENCE));
      const headers = signedHeaders(rawBody);
      const failed = await post(rawBody, headers);
      tasker.finalizeResult = { runId: "run-1" };

      const retry = await readResponse(await post(rawBody, headers));

      expect(failed.status).toBe(500);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(OK_BODY);
      expect(tasker.finalizeCalls).toHaveLength(2);
    });
  });

  describe("no leak", () => {
    it("logs neither the raw body nor the secret for a 401 and a 400", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const sessionId = await seedTranscribing();
      const unsignedBody = JSON.stringify(passagesEvent(sessionId, FRESH_SEQUENCE, [passage(0)]));
      const invalidBody = JSON.stringify(passagesEvent(sessionId, 0, [passage(0)]));

      const unauthorized = await post(
        unsignedBody,
        signedHeaders(unsignedBody, { secret: "another-secret" })
      );
      const invalid = await post(invalidBody, signedHeaders(invalidBody));

      expect(unauthorized.status).toBe(401);
      expect(invalid.status).toBe(400);
      const logged = `${loggedOutput()}\n${serializeCalls(consoleError.mock.calls)}`;
      expect(logged).not.toContain(unsignedBody);
      expect(logged).not.toContain(invalidBody);
      expect(logged).not.toContain(PASSAGE_TEXT);
      expect(logged).not.toContain(SECRET);
    });
  });
});
