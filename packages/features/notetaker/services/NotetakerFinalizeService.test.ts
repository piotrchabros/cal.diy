import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { NotetakerPassageRecord } from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { getDurationWeightedLanguage, NotetakerFinalizeService } from "./NotetakerFinalizeService";

const BOOKING_ID = 100;
const NOW = new Date("2026-10-12T11:00:00.000Z");
const SEEDED_ENDED_AT = new Date("2026-10-12T10:40:00.000Z");

function buildBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: "booking-uid-1",
    userId: 1,
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
    organizer: { id: 1, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

function buildPassage(overrides: Partial<NotetakerPassageRecord>): NotetakerPassageRecord {
  return {
    index: 0,
    speakerKey: "speaker-1",
    speakerName: "Alex",
    unknownSpeakerNumber: null,
    startMs: 0,
    endMs: 1000,
    text: "hello",
    language: "en",
    ...overrides,
  };
}

function buildTwoPassages(): NotetakerPassageRecord[] {
  return [
    buildPassage({ index: 0, startMs: 0, endMs: 4000, language: "en" }),
    buildPassage({ index: 1, startMs: 4000, endMs: 9000, language: "en" }),
  ];
}

class RecordingNotetakerTasker implements INotetakerTasker {
  sendNotificationCalls: {
    payload: NotetakerSendNotificationPayload;
    options: TriggerOptions | undefined;
  }[] = [];
  finalizeSessionCalls: NotetakerFinalizeSessionPayload[] = [];
  generateSummaryCalls: NotetakerGenerateSummaryPayload[] = [];
  sendNotificationRunId = "run-1";

  async finalizeSession(payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    this.finalizeSessionCalls.push(payload);
    return { runId: "run-finalize" };
  }

  async generateSummary(payload: NotetakerGenerateSummaryPayload): Promise<{ runId: string }> {
    this.generateSummaryCalls.push(payload);
    return { runId: "run-summary" };
  }

  async sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.sendNotificationCalls.push({ payload, options });
    return { runId: this.sendNotificationRunId };
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

describe("NotetakerFinalizeService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let tasker: RecordingNotetakerTasker;
  let logger: ReturnType<typeof createLogger>;
  let service: NotetakerFinalizeService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addBooking(buildBooking());
    tasker = new RecordingNotetakerTasker();
    logger = createLogger();
    service = new NotetakerFinalizeService({
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      notetakerTasker: tasker,
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedProcessingSession(
    params: {
      outcomeReason?: NotetakerOutcomeReasonDto | null;
      endedAt?: Date | null;
      passages?: NotetakerPassageRecord[];
      withTranscript?: boolean;
      reportedDurationMs?: number;
      reportedPassageCount?: number;
      status?: NotetakerSessionStatusDto;
    } = {}
  ): Promise<{ sessionId: string; transcriptId: string | null }> {
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      status: params.status ?? "PROCESSING",
      outcomeReason: params.outcomeReason ?? null,
      endedAt: params.endedAt === undefined ? SEEDED_ENDED_AT : params.endedAt,
    });
    await repositories.sessionRepository.update(session.id, {
      admittedAt: new Date("2026-10-12T10:01:00.000Z"),
    });

    if (params.withTranscript === false) return { sessionId: session.id, transcriptId: null };

    const transcript = await repositories.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId: BOOKING_ID,
    });
    await repositories.transcriptRepository.insertPassages(transcript.id, params.passages ?? []);
    await repositories.transcriptRepository.update(transcript.id, {
      durationMs: params.reportedDurationMs ?? 0,
      passageCount: params.reportedPassageCount ?? 0,
    });
    return { sessionId: session.id, transcriptId: transcript.id };
  }

  async function readSession(sessionId: string) {
    return repositories.sessionRepository.findById(sessionId);
  }

  async function readTranscript(sessionId: string) {
    return repositories.transcriptRepository.findBySessionId(sessionId);
  }

  describe("sessions that are not PROCESSING", () => {
    const statuses: NotetakerSessionStatusDto[] = ["TRANSCRIBING", "READY", "ENDED_EARLY", "FAILED"];

    it.each(statuses)("leaves a %s session and its transcript untouched", async (status) => {
      const { sessionId, transcriptId } = await seedProcessingSession({
        status,
        passages: buildTwoPassages(),
      });
      const sessionBefore = await readSession(sessionId);
      const transcriptBefore = await readTranscript(sessionId);

      await service.finalize({ sessionId });

      expect(await readSession(sessionId)).toEqual(sessionBefore);
      expect(await readTranscript(sessionId)).toEqual(transcriptBefore);
      expect(await repositories.transcriptRepository.countPassages(transcriptId ?? "")).toBe(2);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });
  });

  it("resolves for an unknown session id without notifying or logging an error", async () => {
    await expect(service.finalize({ sessionId: "does-not-exist" })).resolves.toBeUndefined();

    expect(tasker.sendNotificationCalls).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("sessions with passages", () => {
    it("marks a normally ended meeting READY with a COMPLETE transcript", async () => {
      const { sessionId } = await seedProcessingSession({
        outcomeReason: null,
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("READY");
      expect(session?.outcomeReason).toBeNull();
      expect((await readTranscript(sessionId))?.completeness).toBe("COMPLETE");
    });

    it("marks a length-limited meeting READY with a TRUNCATED transcript", async () => {
      const { sessionId } = await seedProcessingSession({
        outcomeReason: "LENGTH_LIMIT_REACHED",
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("READY");
      expect(session?.outcomeReason).toBe("LENGTH_LIMIT_REACHED");
      expect((await readTranscript(sessionId))?.completeness).toBe("TRUNCATED");
    });

    const earlyEnds: NotetakerOutcomeReasonDto[] = [
      "REMOVED_BY_PARTICIPANT",
      "STOPPED_BY_HOST",
      "INTERRUPTED",
    ];

    it.each(earlyEnds)("marks a %s meeting ENDED_EARLY with a PARTIAL transcript", async (reason) => {
      const { sessionId } = await seedProcessingSession({
        outcomeReason: reason,
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("ENDED_EARLY");
      expect(session?.outcomeReason).toBe(reason);
      expect((await readTranscript(sessionId))?.completeness).toBe("PARTIAL");
    });

    it("treats a post-admission MEETING_DID_NOT_START with passages as a normal end", async () => {
      const { sessionId } = await seedProcessingSession({
        outcomeReason: "MEETING_DID_NOT_START",
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("READY");
      expect(session?.outcomeReason).toBeNull();
      expect((await readTranscript(sessionId))?.completeness).toBe("COMPLETE");
    });
  });

  describe("sessions without passages", () => {
    const zeroPassageCases: {
      stored: NotetakerOutcomeReasonDto | null;
      expected: NotetakerOutcomeReasonDto;
    }[] = [
      { stored: null, expected: "NO_SPEECH_DETECTED" },
      { stored: "LENGTH_LIMIT_REACHED", expected: "NO_SPEECH_DETECTED" },
      { stored: "MEETING_DID_NOT_START", expected: "MEETING_DID_NOT_START" },
      { stored: "REMOVED_BY_PARTICIPANT", expected: "REMOVED_BY_PARTICIPANT" },
      { stored: "STOPPED_BY_HOST", expected: "STOPPED_BY_HOST" },
      { stored: "INTERRUPTED", expected: "INTERRUPTED" },
    ];

    it.each(
      zeroPassageCases
    )("fails with $expected and removes the empty transcript when the stored reason is $stored", async ({
      stored,
      expected,
    }) => {
      const { sessionId } = await seedProcessingSession({ outcomeReason: stored });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("FAILED");
      expect(session?.outcomeReason).toBe(expected);
      expect(await readTranscript(sessionId)).toBeNull();
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("fails a session that never had a transcript row without deleting anything", async () => {
      const deleteSpy = vi.spyOn(repositories.transcriptRepository, "deleteById");
      const { sessionId } = await seedProcessingSession({ outcomeReason: null, withTranscript: false });

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("FAILED");
      expect(session?.outcomeReason).toBe("NO_SPEECH_DETECTED");
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(tasker.sendNotificationCalls).toHaveLength(0);
      expect(tasker.finalizeSessionCalls).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("deletes the transcript before writing the FAILED status", async () => {
      const deleteSpy = vi.spyOn(repositories.transcriptRepository, "deleteById");
      const updateSpy = vi.spyOn(repositories.sessionRepository, "updateIfStatusIn");
      const { sessionId } = await seedProcessingSession({ outcomeReason: null });

      await service.finalize({ sessionId });

      expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(updateSpy.mock.invocationCallOrder[0]);
      expect(updateSpy).toHaveBeenCalledWith(sessionId, ["PROCESSING"], {
        status: "FAILED",
        outcomeReason: "NO_SPEECH_DETECTED",
        endedAt: SEEDED_ENDED_AT,
      });
    });

    it("recovers on retry when the process dies between the delete and the status write", async () => {
      vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockRejectedValueOnce(
        new Error("db down")
      );
      const { sessionId } = await seedProcessingSession({ outcomeReason: null });

      await expect(service.finalize({ sessionId })).rejects.toThrow("db down");

      expect((await readSession(sessionId))?.status).toBe("PROCESSING");
      expect(await readTranscript(sessionId)).toBeNull();

      await service.finalize({ sessionId });

      const session = await readSession(sessionId);
      expect(session?.status).toBe("FAILED");
      expect(session?.outcomeReason).toBe("NO_SPEECH_DETECTED");
    });
  });

  describe("transcript columns", () => {
    it("writes the stored row count as passageCount and only logs a mismatch with the reported count", async () => {
      const { sessionId } = await seedProcessingSession({
        passages: buildTwoPassages(),
        reportedPassageCount: 5,
      });

      await service.finalize({ sessionId });

      expect((await readTranscript(sessionId))?.passageCount).toBe(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((await readSession(sessionId))?.status).toBe("READY");
    });

    it("does not warn when the reported count matches or nothing was reported", async () => {
      const matching = await seedProcessingSession({
        passages: buildTwoPassages(),
        reportedPassageCount: 2,
      });
      await service.finalize({ sessionId: matching.sessionId });

      const unreported = await seedProcessingSession({ passages: buildTwoPassages() });
      await service.finalize({ sessionId: unreported.sessionId });

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps the duration reported by the event", async () => {
      const { sessionId } = await seedProcessingSession({
        passages: buildTwoPassages(),
        reportedDurationMs: 600000,
      });

      await service.finalize({ sessionId });

      expect((await readTranscript(sessionId))?.durationMs).toBe(600000);
    });

    it("falls back to the largest passage end when no duration was reported", async () => {
      const { sessionId } = await seedProcessingSession({
        passages: [
          buildPassage({ index: 0, startMs: 0, endMs: 9000 }),
          buildPassage({ index: 1, startMs: 2000, endMs: 5000 }),
        ],
        reportedDurationMs: 0,
      });

      await service.finalize({ sessionId });

      expect((await readTranscript(sessionId))?.durationMs).toBe(9000);
    });

    it("writes the duration-weighted language", async () => {
      const { sessionId } = await seedProcessingSession({
        passages: [
          buildPassage({ index: 0, startMs: 0, endMs: 1000, language: "en" }),
          buildPassage({ index: 1, startMs: 1000, endMs: 6000, language: "pl" }),
          buildPassage({ index: 2, startMs: 6000, endMs: 8000, language: "en" }),
        ],
      });

      await service.finalize({ sessionId });

      expect((await readTranscript(sessionId))?.language).toBe("pl");
    });
  });

  describe("endedAt", () => {
    it("keeps an endedAt that was already recorded", async () => {
      const { sessionId } = await seedProcessingSession({
        endedAt: SEEDED_ENDED_AT,
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });

      expect((await readSession(sessionId))?.endedAt).toEqual(SEEDED_ENDED_AT);
    });

    it("stamps the current time when no endedAt was recorded", async () => {
      const { sessionId } = await seedProcessingSession({ endedAt: null, passages: buildTwoPassages() });

      await service.finalize({ sessionId });

      expect((await readSession(sessionId))?.endedAt).toEqual(NOW);
    });
  });

  describe("idempotency", () => {
    it("changes nothing and notifies once when run twice on a session with passages", async () => {
      const { sessionId } = await seedProcessingSession({
        outcomeReason: null,
        passages: buildTwoPassages(),
      });

      await service.finalize({ sessionId });
      const sessionAfterFirst = await readSession(sessionId);
      const transcriptAfterFirst = await readTranscript(sessionId);
      await service.finalize({ sessionId });

      expect(await readSession(sessionId)).toEqual(sessionAfterFirst);
      expect(await readTranscript(sessionId)).toEqual(transcriptAfterFirst);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("stays FAILED without notifying when run twice on a session without passages", async () => {
      const { sessionId } = await seedProcessingSession({ outcomeReason: null });

      await service.finalize({ sessionId });
      const sessionAfterFirst = await readSession(sessionId);
      await service.finalize({ sessionId });

      expect(await readSession(sessionId)).toEqual(sessionAfterFirst);
      expect((await readSession(sessionId))?.status).toBe("FAILED");
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });
  });

  describe("RESULTS_READY notification", () => {
    const seeds: { name: string; outcomeReason: NotetakerOutcomeReasonDto | null }[] = [
      { name: "READY", outcomeReason: null },
      { name: "ENDED_EARLY", outcomeReason: "STOPPED_BY_HOST" },
    ];

    it.each(seeds)("is enqueued once with an idempotency key for a $name session", async ({
      outcomeReason,
    }) => {
      const { sessionId } = await seedProcessingSession({ outcomeReason, passages: buildTwoPassages() });

      await service.finalize({ sessionId });

      expect(tasker.sendNotificationCalls).toHaveLength(1);
      expect(tasker.sendNotificationCalls[0].payload).toEqual({
        kind: "RESULTS_READY",
        bookingId: BOOKING_ID,
        sessionId,
      });
      expect(tasker.sendNotificationCalls[0].options).toEqual({
        idempotencyKey: `notetaker:RESULTS_READY:${sessionId}`,
      });
      expect(tasker.finalizeSessionCalls).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("is enqueued only after the status was written", async () => {
      const updateSpy = vi.spyOn(repositories.sessionRepository, "updateIfStatusIn");
      const sendSpy = vi.spyOn(tasker, "sendNotification");
      const { sessionId } = await seedProcessingSession({ passages: buildTwoPassages() });

      await service.finalize({ sessionId });

      expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(sendSpy.mock.invocationCallOrder[0]);
    });

    it("is not enqueued when another worker already moved the session", async () => {
      vi.spyOn(repositories.sessionRepository, "updateIfStatusIn").mockResolvedValueOnce(false);
      const { sessionId } = await seedProcessingSession({ passages: buildTwoPassages() });

      await expect(service.finalize({ sessionId })).resolves.toBeUndefined();

      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("logs a task-failed run instead of throwing", async () => {
      tasker.sendNotificationRunId = "task-failed";
      const { sessionId } = await seedProcessingSession({ passages: buildTwoPassages() });

      await expect(service.finalize({ sessionId })).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect((await readSession(sessionId))?.status).toBe("READY");
    });
  });

  it("never puts passage text in a log argument", async () => {
    const secretText = "the-launch-code-is-swordfish";
    tasker.sendNotificationRunId = "task-failed";
    const { sessionId } = await seedProcessingSession({
      passages: [
        buildPassage({ index: 0, startMs: 0, endMs: 4000, text: secretText }),
        buildPassage({ index: 1, startMs: 4000, endMs: 9000, text: secretText }),
      ],
      reportedPassageCount: 5,
    });

    await service.finalize({ sessionId });

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secretText);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secretText);
  });
});

describe("getDurationWeightedLanguage", () => {
  it("returns null for no passages", () => {
    expect(getDurationWeightedLanguage([])).toBeNull();
  });

  it("returns null when no passage has a language", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 0, endMs: 1000, language: null },
        { startMs: 1000, endMs: 2000, language: null },
      ])
    ).toBeNull();
  });

  it("returns the only language", () => {
    expect(getDurationWeightedLanguage([{ startMs: 0, endMs: 1000, language: "en" }])).toBe("en");
  });

  it("prefers the larger total duration over the larger passage count", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 0, endMs: 1000, language: "en" },
        { startMs: 1000, endMs: 2000, language: "en" },
        { startMs: 2000, endMs: 3000, language: "en" },
        { startMs: 3000, endMs: 8000, language: "pl" },
      ])
    ).toBe("pl");
  });

  it("ignores passages without a language even when they dominate", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 0, endMs: 50000, language: null },
        { startMs: 50000, endMs: 50100, language: "en" },
      ])
    ).toBe("en");
  });

  it("breaks a tie in favour of the language seen first", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 0, endMs: 1000, language: "de" },
        { startMs: 1000, endMs: 2000, language: "fr" },
      ])
    ).toBe("de");
  });

  it("returns the first seen language when every duration is zero", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 500, endMs: 500, language: "fr" },
        { startMs: 900, endMs: 900, language: "de" },
      ])
    ).toBe("fr");
  });

  it("counts a passage that ends before it starts as zero", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 5000, endMs: 1000, language: "en" },
        { startMs: 0, endMs: 10, language: "pl" },
      ])
    ).toBe("pl");
  });

  it("ignores an empty-string language", () => {
    expect(
      getDurationWeightedLanguage([
        { startMs: 0, endMs: 9000, language: "" },
        { startMs: 9000, endMs: 9100, language: "en" },
      ])
    ).toBe("en");
  });
});
