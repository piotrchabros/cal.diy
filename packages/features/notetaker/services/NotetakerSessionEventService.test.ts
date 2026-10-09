import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  NotetakerBotEndReason,
  NotetakerBotEvent,
  NotetakerBotPassage,
} from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProcessingOutcomeReason, mapOutcome } from "../lib/sessionStateMachine";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { NotetakerSessionUpdateInput } from "../repositories/interfaces/INotetakerSessionRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerSessionEventService } from "./NotetakerSessionEventService";

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;

const NOW = new Date("2026-10-12T12:00:00.000Z");
const OCCURRED_AT = "2026-10-12T10:05:00.000Z";
const ADMITTED_AT = new Date("2026-10-12T10:01:00.000Z");
const EVENT_ID = "00000000-0000-4000-8000-0000000000aa";
const FRESH_SEQUENCE = 10;
const SEEDED_SEQUENCE = 3;
const PASSAGE_TEXT = "confidential-passage-text-should-never-be-logged";

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

function envelope(sequence: number): {
  eventId: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
} {
  return { eventId: EVENT_ID, sessionId: "", sequence, occurredAt: OCCURRED_AT };
}

function withSession(sessionId: string, event: NotetakerBotEvent): NotetakerBotEvent {
  return { ...event, sessionId };
}

function joinRequested(sequence: number): NotetakerBotEvent {
  return { ...envelope(sequence), type: "session.join_requested", data: {} };
}

function admitted(sequence: number): NotetakerBotEvent {
  return { ...envelope(sequence), type: "session.admitted", data: {} };
}

function noticePosted(sequence: number): NotetakerBotEvent {
  return { ...envelope(sequence), type: "session.notice_posted", data: {} };
}

function heartbeat(sequence: number): NotetakerBotEvent {
  return { ...envelope(sequence), type: "session.heartbeat", data: { participantCount: 2 } };
}

function reconnecting(sequence: number, atMs: number): NotetakerBotEvent {
  return { ...envelope(sequence), type: "session.reconnecting", data: { atMs } };
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

function passagesEvent(sequence: number, indexes: number[]): NotetakerBotEvent {
  return {
    ...envelope(sequence),
    type: "transcript.passages",
    data: { passages: indexes.map((index) => passage(index)) },
  };
}

function ended(
  sequence: number,
  overrides: Partial<{
    endReason: NotetakerBotEndReason;
    durationMs: number;
    interruptedAtMs: number | null;
    passageCount: number;
  }> = {}
): NotetakerBotEvent {
  return {
    ...envelope(sequence),
    type: "session.ended",
    data: {
      endReason: "MEETING_ENDED",
      durationMs: 60_000,
      interruptedAtMs: null,
      passageCount: 3,
      ...overrides,
    },
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

function expectedPreAdmissionOutcome(endReason: NotetakerBotEndReason): {
  status: NotetakerSessionStatusDto;
  outcomeReason: NotetakerOutcomeReasonDto | null;
} {
  const outcome = mapOutcome({ cause: endReason, admitted: false, passageCount: 0 });
  if (outcome.kind !== "OUTCOME") {
    throw new Error(`Expected an outcome for ${endReason} before admission`);
  }
  return { status: outcome.status, outcomeReason: outcome.outcomeReason };
}

describe("NotetakerSessionEventService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let tasker: RecordingTasker;
  let logger: ISimpleLogger;
  let service: NotetakerSessionEventService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addBooking(buildBooking());
    tasker = new RecordingTasker();
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    service = new NotetakerSessionEventService({
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      activityRepository: repositories.activityRepository,
      notetakerTasker: tasker,
      logger,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  function seedChoice(overrides: Partial<{ enabled: boolean; pendingDispatch: boolean }> = {}) {
    return repositories.bookingNotetakerRepository.upsert({
      bookingId: BOOKING_ID,
      enabled: true,
      pendingDispatch: false,
      source: "HOST",
      appliedToSeries: false,
      setByUserId: ORGANIZER_ID,
      setAt: NOW,
      ...overrides,
    });
  }

  function choiceOf() {
    const choice = repositories.store.choices.get(BOOKING_ID);
    if (!choice) throw new Error(`Choice for booking ${BOOKING_ID} is missing from the store`);
    return { ...choice };
  }

  function activities() {
    return repositories.store.activities.map((activity) => ({ ...activity }));
  }

  function expectedStoppedActivity(sessionId: string) {
    return expect.objectContaining({
      bookingId: BOOKING_ID,
      sessionId,
      action: "STOPPED",
      actorType: "PARTICIPANT",
      actorUserId: null,
      actorName: null,
      detail: null,
    });
  }

  function recordCallOrder(sessionId: string): { order: string[]; statusAtBlock: string[] } {
    const order: string[] = [];
    const statusAtBlock: string[] = [];
    const choices = repositories.bookingNotetakerRepository;
    const sessions = repositories.sessionRepository;
    const activityRepo = repositories.activityRepository;
    const transcripts = repositories.transcriptRepository;

    const setRejoinBlocked = choices.setRejoinBlocked.bind(choices);
    vi.spyOn(choices, "setRejoinBlocked").mockImplementation((...args) => {
      order.push("setRejoinBlocked");
      statusAtBlock.push(sessionOf(sessionId).status);
      return setRejoinBlocked(...args);
    });
    const setPendingDispatch = choices.setPendingDispatch.bind(choices);
    vi.spyOn(choices, "setPendingDispatch").mockImplementation((...args) => {
      order.push("setPendingDispatch");
      return setPendingDispatch(...args);
    });
    const updateIfStatusIn = sessions.updateIfStatusIn.bind(sessions);
    vi.spyOn(sessions, "updateIfStatusIn").mockImplementation((...args) => {
      order.push("updateIfStatusIn");
      return updateIfStatusIn(...args);
    });
    const createActivity = activityRepo.create.bind(activityRepo);
    vi.spyOn(activityRepo, "create").mockImplementation((...args) => {
      order.push("activity");
      return createActivity(...args);
    });
    const updateTranscript = transcripts.update.bind(transcripts);
    vi.spyOn(transcripts, "update").mockImplementation((...args) => {
      order.push("transcript.update");
      return updateTranscript(...args);
    });
    const finalizeSession = tasker.finalizeSession.bind(tasker);
    vi.spyOn(tasker, "finalizeSession").mockImplementation((...args) => {
      order.push("finalize");
      return finalizeSession(...args);
    });
    return { order, statusAtBlock };
  }

  function transcriptOf(sessionId: string) {
    return Array.from(repositories.store.transcripts.values()).find(
      (transcript) => transcript.sessionId === sessionId
    );
  }

  function storedPassageCount(sessionId: string): number {
    const transcript = transcriptOf(sessionId);
    if (!transcript) return 0;
    return repositories.store.passages.get(transcript.id)?.size ?? 0;
  }

  function snapshot(sessionId: string) {
    return {
      session: repositories.store.sessions.get(sessionId) ? sessionOf(sessionId) : null,
      transcripts: Array.from(repositories.store.transcripts.values()).map((transcript) => ({
        ...transcript,
      })),
      passageCount: storedPassageCount(sessionId),
    };
  }

  function expectNoTaskerCalls(): void {
    expect(tasker.finalizeCalls).toEqual([]);
    expect(tasker.summaryCalls).toEqual([]);
    expect(tasker.notificationCalls).toEqual([]);
  }

  it("returns GONE for an unknown session", async () => {
    const result = await service.handleEvent(
      withSession("00000000-0000-4000-8000-ffffffffffff", heartbeat(1))
    );

    expect(result).toBe("GONE");
    expectNoTaskerCalls();
  });

  it.each([
    ["equal to the stored sequence", SEEDED_SEQUENCE],
    ["lower than the stored sequence", SEEDED_SEQUENCE - 1],
  ])("returns DUPLICATE and changes nothing when the sequence is %s", async (_name, sequence) => {
    const sessionId = await seedTranscribing();
    const before = snapshot(sessionId);

    const result = await service.handleEvent(withSession(sessionId, passagesEvent(sequence, [7])));

    expect(result).toBe("DUPLICATE");
    expect(snapshot(sessionId)).toEqual(before);
    expect(repositories.store.transcripts.size).toBe(0);
    expectNoTaskerCalls();
  });

  it.each<NotetakerSessionStatusDto>([
    "PROCESSING",
    "READY",
    "ENDED_EARLY",
    "FAILED",
  ])("returns GONE and changes nothing for a %s session", async (status) => {
    const sessionId = await seedTranscribing({ status });
    const before = snapshot(sessionId);

    const result = await service.handleEvent(withSession(sessionId, heartbeat(FRESH_SEQUENCE)));

    expect(result).toBe("GONE");
    expect(snapshot(sessionId)).toEqual(before);
    expectNoTaskerCalls();
  });

  it.each<[string, NotetakerSessionUpdateInput, (sequence: number) => NotetakerBotEvent]>([
    ["session.join_requested", { status: "SCHEDULED", admittedAt: null }, joinRequested],
    ["session.admitted", { status: "WAITING_TO_BE_ADMITTED", admittedAt: null }, admitted],
    ["session.notice_posted", {}, noticePosted],
    ["session.heartbeat", {}, heartbeat],
    ["session.reconnecting", {}, (sequence) => reconnecting(sequence, 1234)],
    ["transcript.passages", {}, (sequence) => passagesEvent(sequence, [0])],
    ["session.ended", {}, (sequence) => ended(sequence)],
  ])("stores the sequence of an accepted %s event", async (_type, patch, build) => {
    const sessionId = await seedTranscribing(patch);

    const result = await service.handleEvent(withSession(sessionId, build(FRESH_SEQUENCE)));

    expect(result).toBe("ACCEPTED");
    expect(sessionOf(sessionId).lastEventSequence).toBe(FRESH_SEQUENCE);
  });

  describe("session.join_requested", () => {
    it("moves SCHEDULED to WAITING_TO_BE_ADMITTED and records the bot's timestamp", async () => {
      const sessionId = await seedSession();

      const result = await service.handleEvent(withSession(sessionId, joinRequested(1)));

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("WAITING_TO_BE_ADMITTED");
      expect(session.joinRequestedAt).toEqual(new Date(OCCURRED_AT));
      expect(session.joinRequestedAt).not.toEqual(NOW);
    });

    it("returns GONE for a TRANSCRIBING session and changes nothing", async () => {
      const sessionId = await seedTranscribing();
      const before = snapshot(sessionId);

      const result = await service.handleEvent(withSession(sessionId, joinRequested(FRESH_SEQUENCE)));

      expect(result).toBe("GONE");
      expect(snapshot(sessionId)).toEqual(before);
    });
  });

  describe("session.admitted", () => {
    it.each<NotetakerSessionStatusDto>([
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
    ])("moves %s to TRANSCRIBING and records the bot's timestamp", async (status) => {
      const sessionId = await seedSession({ status });

      const result = await service.handleEvent(withSession(sessionId, admitted(1)));

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("TRANSCRIBING");
      expect(session.admittedAt).toEqual(new Date(OCCURRED_AT));
      expect(session.admittedAt).not.toEqual(NOW);
    });
  });

  describe("session.notice_posted", () => {
    it("changes only noticePostedAt and the sequence", async () => {
      const sessionId = await seedTranscribing();
      const before = sessionOf(sessionId);

      const result = await service.handleEvent(withSession(sessionId, noticePosted(FRESH_SEQUENCE)));

      expect(result).toBe("ACCEPTED");
      expect(sessionOf(sessionId)).toEqual({
        ...before,
        noticePostedAt: new Date(OCCURRED_AT),
        lastEventSequence: FRESH_SEQUENCE,
      });
    });
  });

  describe("session.heartbeat", () => {
    it("stamps lastHeartbeatAt with the app clock and changes nothing else but the sequence", async () => {
      const sessionId = await seedTranscribing();
      const before = sessionOf(sessionId);

      const result = await service.handleEvent(withSession(sessionId, heartbeat(FRESH_SEQUENCE)));

      expect(result).toBe("ACCEPTED");
      expect(sessionOf(sessionId)).toEqual({
        ...before,
        lastHeartbeatAt: NOW,
        lastEventSequence: FRESH_SEQUENCE,
      });
      expect(sessionOf(sessionId).lastHeartbeatAt).not.toEqual(new Date(OCCURRED_AT));
    });
  });

  describe("session.reconnecting", () => {
    it("records the rejoin attempt and the interruption point while staying TRANSCRIBING", async () => {
      const sessionId = await seedTranscribing();

      const result = await service.handleEvent(withSession(sessionId, reconnecting(FRESH_SEQUENCE, 4321)));

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.rejoinAttempted).toBe(true);
      expect(session.interruptedAtMs).toBe(4321);
      expect(session.status).toBe("TRANSCRIBING");
    });
  });

  describe("transcript.passages", () => {
    it("creates the PARTIAL transcript on the first event, appends on the next and skips repeated indexes", async () => {
      const sessionId = await seedTranscribing();

      expect(await service.handleEvent(withSession(sessionId, passagesEvent(4, [0, 1])))).toBe("ACCEPTED");
      const transcript = transcriptOf(sessionId);
      expect(transcript).toBeDefined();
      expect(transcript?.completeness).toBe("PARTIAL");
      expect(transcript?.bookingId).toBe(BOOKING_ID);
      expect(storedPassageCount(sessionId)).toBe(2);

      expect(await service.handleEvent(withSession(sessionId, passagesEvent(5, [2])))).toBe("ACCEPTED");
      expect(storedPassageCount(sessionId)).toBe(3);

      expect(await service.handleEvent(withSession(sessionId, passagesEvent(6, [1])))).toBe("ACCEPTED");
      expect(storedPassageCount(sessionId)).toBe(3);
      expect(repositories.store.transcripts.size).toBe(1);
      expect(sessionOf(sessionId).lastEventSequence).toBe(6);
    });

    it("returns GONE before admission and creates no transcript", async () => {
      const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
      const before = snapshot(sessionId);

      const result = await service.handleEvent(withSession(sessionId, passagesEvent(FRESH_SEQUENCE, [0])));

      expect(result).toBe("GONE");
      expect(repositories.store.transcripts.size).toBe(0);
      expect(snapshot(sessionId)).toEqual(before);
    });
  });

  describe("session.ended after admission", () => {
    it("moves to PROCESSING, records the end and enqueues finalize", async () => {
      const sessionId = await seedTranscribing({ interruptedAtMs: 1000 });

      const result = await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)));

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.endedAt).toEqual(new Date(OCCURRED_AT));
      expect(session.interruptedAtMs).toBeNull();
      expect(session.lastEventSequence).toBe(FRESH_SEQUENCE);
      expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
    });

    it("overwrites interruptedAtMs with the value from the event", async () => {
      const sessionId = await seedTranscribing({ interruptedAtMs: 1000 });

      await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE, { interruptedAtMs: 5000 })));

      expect(sessionOf(sessionId).interruptedAtMs).toBe(5000);
    });

    it.each<[NotetakerBotEndReason, NotetakerOutcomeReasonDto | null]>([
      ["MEETING_ENDED", null],
      ["ALONE_TIMEOUT", null],
      ["NOT_ADMITTED", "INTERRUPTED"],
      ["INTERRUPTED", "INTERRUPTED"],
      ["MEETING_LINK_UNUSABLE", "INTERRUPTED"],
      ["MEETING_DID_NOT_START", "MEETING_DID_NOT_START"],
      ["REMOVED_BY_PARTICIPANT", "REMOVED_BY_PARTICIPANT"],
      ["STOP_REQUESTED", "STOPPED_BY_HOST"],
      ["LENGTH_LIMIT_REACHED", "LENGTH_LIMIT_REACHED"],
    ])("stores the PROCESSING outcome reason for %s", async (endReason, expectedReason) => {
      const sessionId = await seedTranscribing();

      await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE, { endReason })));

      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe(expectedReason);
      expect(session.outcomeReason).toBe(getProcessingOutcomeReason(endReason));
    });

    it("copies duration and passage count to an existing transcript and keeps it PARTIAL", async () => {
      const sessionId = await seedTranscribing();
      await repositories.transcriptRepository.createIfMissing({ sessionId, bookingId: BOOKING_ID });

      await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { durationMs: 90_000, passageCount: 4 }))
      );

      const transcript = transcriptOf(sessionId);
      expect(transcript?.durationMs).toBe(90_000);
      expect(transcript?.passageCount).toBe(4);
      expect(transcript?.completeness).toBe("PARTIAL");
    });

    it("creates no transcript when none exists", async () => {
      const sessionId = await seedTranscribing();

      await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE, { passageCount: 0 })));

      expect(repositories.store.transcripts.size).toBe(0);
    });

    it("throws when the finalize enqueue fails, after the session is already PROCESSING", async () => {
      const sessionId = await seedTranscribing();
      tasker.finalizeResult = { runId: "task-failed" };

      const promise = service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)));

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.lastEventSequence).toBe(FRESH_SEQUENCE);
    });

    it("re-enqueues finalize when the bot retries the same ended event", async () => {
      const sessionId = await seedTranscribing();
      tasker.finalizeResult = { runId: "task-failed" };
      await expect(service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)))).rejects.toBeInstanceOf(
        ErrorWithCode
      );
      const before = snapshot(sessionId);
      tasker.finalizeResult = { runId: "run-2" };

      const result = await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)));

      expect(result).toBe("DUPLICATE");
      expect(tasker.finalizeCalls).toEqual([{ sessionId }, { sessionId }]);
      expect(snapshot(sessionId)).toEqual(before);
    });

    it("throws again when the re-enqueue of a duplicate ended event fails too", async () => {
      const sessionId = await seedTranscribing();
      tasker.finalizeResult = { runId: "task-failed" };
      await expect(service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)))).rejects.toBeInstanceOf(
        ErrorWithCode
      );

      const promise = service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)));

      await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
      expect(tasker.finalizeCalls).toHaveLength(2);
      expect(sessionOf(sessionId).status).toBe("PROCESSING");
    });

    it("does not enqueue finalize for a duplicate ended event once the session is READY", async () => {
      const sessionId = await seedTranscribing({ status: "READY", lastEventSequence: FRESH_SEQUENCE });
      const before = snapshot(sessionId);

      const result = await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE)));

      expect(result).toBe("DUPLICATE");
      expect(snapshot(sessionId)).toEqual(before);
      expectNoTaskerCalls();
    });
  });

  describe("session.ended before admission", () => {
    it.each<[NotetakerSessionStatusDto, NotetakerBotEndReason]>([
      ["WAITING_TO_BE_ADMITTED", "NOT_ADMITTED"],
      ["SCHEDULED", "MEETING_LINK_UNUSABLE"],
    ])("fails a %s session ended with %s, without finalize or a warning", async (status, endReason) => {
      const sessionId = await seedSession({ status, lastEventSequence: SEEDED_SEQUENCE });
      const expected = expectedPreAdmissionOutcome(endReason);

      const result = await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { endReason, interruptedAtMs: 500, passageCount: 0 }))
      );

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("FAILED");
      expect(session.status).toBe(expected.status);
      expect(session.outcomeReason).toBe(expected.outcomeReason);
      expect(session.endedAt).toEqual(new Date(OCCURRED_AT));
      expect(session.lastEventSequence).toBe(FRESH_SEQUENCE);
      expect(session.interruptedAtMs).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
      expectNoTaskerCalls();
    });

    it("deletes the session row for a pre-admission STOP_REQUESTED", async () => {
      const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });

      const result = await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { endReason: "STOP_REQUESTED", passageCount: 0 }))
      );

      expect(result).toBe("ACCEPTED");
      expect(repositories.store.sessions.has(sessionId)).toBe(false);
      expectNoTaskerCalls();
    });
  });

  describe("normalised end reasons", () => {
    it("fails a pre-admission ALONE_TIMEOUT as MEETING_DID_NOT_START and warns once", async () => {
      const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });

      const result = await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { endReason: "ALONE_TIMEOUT", passageCount: 0 }))
      );

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("FAILED");
      expect(session.outcomeReason).toBe("MEETING_DID_NOT_START");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expectNoTaskerCalls();
    });

    it("processes a post-admission NOT_ADMITTED as INTERRUPTED and warns once", async () => {
      const sessionId = await seedTranscribing();

      const result = await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { endReason: "NOT_ADMITTED" }))
      );

      expect(result).toBe("ACCEPTED");
      const session = sessionOf(sessionId);
      expect(session.status).toBe("PROCESSING");
      expect(session.outcomeReason).toBe("INTERRUPTED");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
    });
  });

  describe("lost races", () => {
    it("returns GONE for a heartbeat when the conditional update loses", async () => {
      const sessionId = await seedTranscribing();
      vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

      const result = await service.handleEvent(withSession(sessionId, heartbeat(FRESH_SEQUENCE)));

      expect(result).toBe("GONE");
    });

    it("returns GONE for a post-admission ended event, skipping the transcript update and finalize", async () => {
      const sessionId = await seedTranscribing();
      await repositories.transcriptRepository.createIfMissing({ sessionId, bookingId: BOOKING_ID });
      const transcriptBefore = transcriptOf(sessionId);
      vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

      const result = await service.handleEvent(
        withSession(sessionId, ended(FRESH_SEQUENCE, { durationMs: 90_000, passageCount: 4 }))
      );

      expect(result).toBe("GONE");
      expect(transcriptOf(sessionId)).toEqual(transcriptBefore);
      expectNoTaskerCalls();
    });
  });

  describe("rejoin block and participant stop", () => {
    describe("REMOVED_BY_PARTICIPANT after admission", () => {
      const removed = () => ended(FRESH_SEQUENCE, { endReason: "REMOVED_BY_PARTICIPANT" });

      it("blocks rejoin, clears the pending dispatch and records one STOPPED activity", async () => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("ACCEPTED");
        const choice = choiceOf();
        expect(choice.rejoinBlocked).toBe(true);
        expect(choice.pendingDispatch).toBe(false);
        expect(choice.enabled).toBe(true);
        const session = sessionOf(sessionId);
        expect(session.status).toBe("PROCESSING");
        expect(session.outcomeReason).toBe("REMOVED_BY_PARTICIPANT");
        expect(activities()).toEqual([expectedStoppedActivity(sessionId)]);
        expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
        expect(tasker.notificationCalls).toEqual([]);
      });

      it("blocks and clears before the status write, then records the activity before the transcript and finalize", async () => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });
        await repositories.transcriptRepository.createIfMissing({ sessionId, bookingId: BOOKING_ID });
        const { order, statusAtBlock } = recordCallOrder(sessionId);

        await service.handleEvent(withSession(sessionId, removed()));

        expect(order).toEqual([
          "setRejoinBlocked",
          "setPendingDispatch",
          "updateIfStatusIn",
          "activity",
          "transcript.update",
          "finalize",
        ]);
        expect(statusAtBlock).toEqual(["TRANSCRIBING"]);
      });

      it("keeps the block but records no activity and enqueues nothing when the status write loses", async () => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });
        const before = sessionOf(sessionId);
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("GONE");
        const choice = choiceOf();
        expect(choice.rejoinBlocked).toBe(true);
        expect(choice.pendingDispatch).toBe(false);
        expect(activities()).toEqual([]);
        expectNoTaskerCalls();
        expect(sessionOf(sessionId)).toEqual(before);
      });

      it("records the activity once when a failed finalize enqueue is retried by the bot", async () => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });
        tasker.finalizeResult = { runId: "task-failed" };

        await expect(service.handleEvent(withSession(sessionId, removed()))).rejects.toBeInstanceOf(
          ErrorWithCode
        );
        expect(activities()).toHaveLength(1);
        tasker.finalizeResult = { runId: "run-2" };

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("DUPLICATE");
        expect(tasker.finalizeCalls).toEqual([{ sessionId }, { sessionId }]);
        expect(activities()).toHaveLength(1);
        expect(choiceOf().rejoinBlocked).toBe(true);
      });

      it("still records the activity when the booking has no notetaker choice row", async () => {
        const sessionId = await seedTranscribing();

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("ACCEPTED");
        expect(repositories.store.choices.size).toBe(0);
        expect(activities()).toEqual([expectedStoppedActivity(sessionId)]);
      });
    });

    describe("STOP_REQUESTED after admission", () => {
      const stopped = () => ended(FRESH_SEQUENCE, { endReason: "STOP_REQUESTED" });
      const stopRequestedAt = new Date("2026-10-12T10:04:00.000Z");

      it("blocks rejoin without an activity and keeps the stop request fields", async () => {
        const sessionId = await seedTranscribing({
          stopRequestedAt,
          stopRequestedByUserId: ORGANIZER_ID,
        });
        await seedChoice({ pendingDispatch: true });

        const result = await service.handleEvent(withSession(sessionId, stopped()));

        expect(result).toBe("ACCEPTED");
        const choice = choiceOf();
        expect(choice.rejoinBlocked).toBe(true);
        expect(choice.pendingDispatch).toBe(false);
        const session = sessionOf(sessionId);
        expect(session.status).toBe("PROCESSING");
        expect(session.outcomeReason).toBe("STOPPED_BY_HOST");
        expect(session.stopRequestedAt).toEqual(stopRequestedAt);
        expect(session.stopRequestedByUserId).toBe(ORGANIZER_ID);
        expect(activities()).toEqual([]);
        expect(tasker.finalizeCalls).toEqual([{ sessionId }]);
      });

      it("keeps the block but enqueues nothing when the status write loses", async () => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

        const result = await service.handleEvent(withSession(sessionId, stopped()));

        expect(result).toBe("GONE");
        expect(choiceOf().rejoinBlocked).toBe(true);
        expect(activities()).toEqual([]);
        expectNoTaskerCalls();
      });
    });

    describe("REMOVED_BY_PARTICIPANT before admission", () => {
      const removed = () => ended(FRESH_SEQUENCE, { endReason: "REMOVED_BY_PARTICIPANT", passageCount: 0 });

      it.each<NotetakerSessionStatusDto>([
        "SCHEDULED",
        "WAITING_TO_BE_ADMITTED",
      ])("fails a %s session, blocks rejoin and records the activity", async (status) => {
        const sessionId = await seedSession({ status });
        await seedChoice({ pendingDispatch: true });

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("ACCEPTED");
        const session = sessionOf(sessionId);
        expect(session.status).toBe("FAILED");
        expect(session.outcomeReason).toBe("REMOVED_BY_PARTICIPANT");
        const choice = choiceOf();
        expect(choice.rejoinBlocked).toBe(true);
        expect(choice.pendingDispatch).toBe(false);
        expect(activities()).toEqual([expectedStoppedActivity(sessionId)]);
        expectNoTaskerCalls();
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it("blocks and clears before the status write, then records the activity", async () => {
        const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
        await seedChoice({ pendingDispatch: true });
        const { order } = recordCallOrder(sessionId);

        await service.handleEvent(withSession(sessionId, removed()));

        expect(order).toEqual(["setRejoinBlocked", "setPendingDispatch", "updateIfStatusIn", "activity"]);
      });

      it("keeps the block but records no activity when the status write loses", async () => {
        const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
        await seedChoice({ pendingDispatch: true });
        vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);

        const result = await service.handleEvent(withSession(sessionId, removed()));

        expect(result).toBe("GONE");
        expect(choiceOf().rejoinBlocked).toBe(true);
        expect(activities()).toEqual([]);
      });
    });

    describe("STOP_REQUESTED before admission", () => {
      const stopped = () => ended(FRESH_SEQUENCE, { endReason: "STOP_REQUESTED", passageCount: 0 });

      it.each<NotetakerSessionStatusDto>([
        "SCHEDULED",
        "WAITING_TO_BE_ADMITTED",
      ])("deletes a %s session row and leaves the choice and activity log alone", async (status) => {
        const sessionId = await seedSession({ status });
        await seedChoice({ pendingDispatch: true });
        const choiceBefore = choiceOf();

        const result = await service.handleEvent(withSession(sessionId, stopped()));

        expect(result).toBe("ACCEPTED");
        expect(repositories.store.sessions.has(sessionId)).toBe(false);
        expect(choiceOf()).toEqual(choiceBefore);
        expect(activities()).toEqual([]);
        expectNoTaskerCalls();
      });

      it("answers ACCEPTED when the row is already gone by the time it is deleted", async () => {
        const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
        await seedChoice({ pendingDispatch: true });
        const choiceBefore = choiceOf();
        const findById = repositories.sessionRepository.findById.bind(repositories.sessionRepository);
        vi.spyOn(repositories.sessionRepository, "findById").mockImplementationOnce(async (id) => {
          const found = await findById(id);
          repositories.store.sessions.delete(id);
          return found;
        });

        const result = await service.handleEvent(withSession(sessionId, stopped()));

        expect(result).toBe("ACCEPTED");
        expect(choiceOf()).toEqual(choiceBefore);
        expect(activities()).toEqual([]);
        expectNoTaskerCalls();
      });

      it("answers GONE to later events after the row is deleted", async () => {
        const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
        await seedChoice({ pendingDispatch: true });
        const choiceBefore = choiceOf();
        await service.handleEvent(withSession(sessionId, stopped()));

        expect(await service.handleEvent(withSession(sessionId, heartbeat(FRESH_SEQUENCE + 1)))).toBe("GONE");
        expect(await service.handleEvent(withSession(sessionId, stopped()))).toBe("GONE");

        expect(choiceOf()).toEqual(choiceBefore);
      });
    });

    describe("end reasons that never touch the choice", () => {
      const reasons: NotetakerBotEndReason[] = [
        "MEETING_ENDED",
        "ALONE_TIMEOUT",
        "NOT_ADMITTED",
        "MEETING_DID_NOT_START",
        "INTERRUPTED",
        "LENGTH_LIMIT_REACHED",
        "MEETING_LINK_UNUSABLE",
      ];

      it.each(
        reasons
      )("leaves the choice and activity log alone after admission for %s", async (endReason) => {
        const sessionId = await seedTranscribing();
        await seedChoice({ pendingDispatch: true });
        const choiceBefore = choiceOf();

        await service.handleEvent(withSession(sessionId, ended(FRESH_SEQUENCE, { endReason })));

        expect(choiceOf()).toEqual(choiceBefore);
        expect(activities()).toEqual([]);
      });

      it.each(
        reasons
      )("leaves the choice and activity log alone before admission for %s", async (endReason) => {
        const sessionId = await seedSession({ status: "WAITING_TO_BE_ADMITTED" });
        await seedChoice({ pendingDispatch: true });
        const choiceBefore = choiceOf();

        await service.handleEvent(
          withSession(sessionId, ended(FRESH_SEQUENCE, { endReason, passageCount: 0 }))
        );

        expect(choiceOf()).toEqual(choiceBefore);
        expect(activities()).toEqual([]);
      });
    });

    it("leaves the choice and activity log alone for a duplicate REMOVED_BY_PARTICIPANT ended event", async () => {
      const sessionId = await seedTranscribing();
      await seedChoice({ pendingDispatch: true });
      const choiceBefore = choiceOf();

      const result = await service.handleEvent(
        withSession(sessionId, ended(SEEDED_SEQUENCE, { endReason: "REMOVED_BY_PARTICIPANT" }))
      );

      expect(result).toBe("DUPLICATE");
      expect(choiceOf()).toEqual(choiceBefore);
      expect(activities()).toEqual([]);
    });
  });

  describe("privacy and scope", () => {
    it("never logs passage text", async () => {
      const sessionId = await seedTranscribing();

      await service.handleEvent(withSession(sessionId, passagesEvent(4, [0, 1])));
      await service.handleEvent(withSession(sessionId, ended(5, { endReason: "NOT_ADMITTED" })));
      await service.handleEvent(withSession(sessionId, passagesEvent(6, [2])));

      const logged = [logger.debug, logger.info, logger.warn, logger.error]
        .map((fn) => JSON.stringify(vi.mocked(fn).mock.calls))
        .join("\n");
      expect(logger.warn).toHaveBeenCalled();
      expect(logged).not.toContain(PASSAGE_TEXT);
    });

    it("never generates summaries or sends notifications over a full lifecycle", async () => {
      const sessionId = await seedSession();

      await service.handleEvent(withSession(sessionId, joinRequested(1)));
      await service.handleEvent(withSession(sessionId, admitted(2)));
      await service.handleEvent(withSession(sessionId, noticePosted(3)));
      await service.handleEvent(withSession(sessionId, heartbeat(4)));
      await service.handleEvent(withSession(sessionId, passagesEvent(5, [0, 1])));
      await service.handleEvent(withSession(sessionId, ended(6, { passageCount: 2 })));
      await service.handleEvent(withSession(sessionId, ended(6, { passageCount: 2 })));

      expect(tasker.finalizeCalls).toEqual([{ sessionId }, { sessionId }]);
      expect(tasker.summaryCalls).toEqual([]);
      expect(tasker.notificationCalls).toEqual([]);
    });
  });
});
