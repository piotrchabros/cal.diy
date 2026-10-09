import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerSummaryContent, NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNotetakerConfig } from "../lib/config";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import type {
  INotetakerSummaryGenerator,
  NotetakerSummaryGeneratorInput,
  NotetakerSummaryResult,
} from "../summary/INotetakerSummaryGenerator";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { NOTETAKER_SUMMARY_MAX_ATTEMPTS, NotetakerSummaryService } from "./NotetakerSummaryService";

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;
const STRANGER_ID = 5;
const NOW = new Date("2026-10-12T11:00:00.000Z");
const SECRET_TOKEN = "zxqvsecretpassagetoken";
const FIRST_DISPATCH = new Date("2026-10-12T09:50:00.000Z");
const SECOND_DISPATCH = new Date("2026-10-12T09:55:00.000Z");

const VALID_CONTENT: NotetakerSummaryContent = {
  language: "pl",
  overview: "Przegląd spotkania",
  keyPoints: ["Punkt"],
  decisions: ["Decyzja"],
  actionItems: [
    { text: "Zadanie", owner: "Ada" },
    { text: "Drugie", owner: null },
  ],
};

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

// 7 words, above the test threshold of 5
function buildEnoughPassages(): NotetakerPassageRecord[] {
  return [
    buildPassage({ index: 0, startMs: 0, endMs: 4000, text: `we shipped ${SECRET_TOKEN} today` }),
    buildPassage({ index: 1, startMs: 4000, endMs: 9000, text: "great news everyone" }),
  ];
}

// 4 words, one below the threshold
function buildTooFewPassages(): NotetakerPassageRecord[] {
  return [
    buildPassage({ index: 0, startMs: 0, endMs: 4000, text: `short ${SECRET_TOKEN}` }),
    buildPassage({ index: 1, startMs: 4000, endMs: 9000, text: "talk here" }),
  ];
}

function buildExactlyFiveWords(): NotetakerPassageRecord[] {
  return [
    buildPassage({ index: 0, startMs: 0, endMs: 4000, text: "one two three" }),
    buildPassage({ index: 1, startMs: 4000, endMs: 9000, text: "four five" }),
  ];
}

class RecordingNotetakerTasker implements INotetakerTasker {
  sendNotificationCalls: {
    payload: NotetakerSendNotificationPayload;
    options: TriggerOptions | undefined;
  }[] = [];
  generateSummaryCalls: {
    payload: NotetakerGenerateSummaryPayload;
    options: TriggerOptions | undefined;
  }[] = [];
  sendNotificationRunId = "run-1";
  generateSummaryRunId = "run-summary";
  // Models the sync tasker finishing or failing the generation inline, before generateSummary returns.
  onGenerateSummary: (() => Promise<void>) | null = null;

  async finalizeSession(_payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    return { runId: "run-finalize" };
  }

  async generateSummary(
    payload: NotetakerGenerateSummaryPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.generateSummaryCalls.push({ payload, options });
    if (this.onGenerateSummary) await this.onGenerateSummary();
    return { runId: this.generateSummaryRunId };
  }

  async sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.sendNotificationCalls.push({ payload, options });
    return { runId: this.sendNotificationRunId };
  }
}

class ScriptedSummaryGenerator implements INotetakerSummaryGenerator {
  inputs: NotetakerSummaryGeneratorInput[] = [];
  queue: (NotetakerSummaryResult | Error)[] = [];
  // Lets a test observe the stored row at the moment the generator runs.
  onGenerate: (() => Promise<void>) | null = null;

  async generate(input: NotetakerSummaryGeneratorInput): Promise<NotetakerSummaryResult> {
    this.inputs.push(input);
    if (this.onGenerate) await this.onGenerate();
    const next = this.queue.shift();
    if (next === undefined) return { ok: true, content: VALID_CONTENT, model: "scripted-model" };
    if (next instanceof Error) throw next;
    return next;
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

const RETRYABLE_PROVIDER_ERROR: NotetakerSummaryResult = {
  ok: false,
  failureCode: "PROVIDER_ERROR",
  retryable: true,
};

describe("NotetakerSummaryService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let tasker: RecordingNotetakerTasker;
  let generator: ScriptedSummaryGenerator;
  let logger: ReturnType<typeof createLogger>;
  let users: NotetakerUserRecord[];
  let service: NotetakerSummaryService;

  const userRepository: INotetakerUserLookup = {
    findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    repositories = createInMemoryNotetakerRepositories();
    repositories.store.addBooking(buildBooking());
    tasker = new RecordingNotetakerTasker();
    generator = new ScriptedSummaryGenerator();
    logger = createLogger();
    users = [
      {
        id: ORGANIZER_ID,
        name: "Olga Organizer",
        email: "organizer@example.com",
        locale: "en",
        timeZone: "UTC",
      },
    ];
    service = new NotetakerSummaryService({
      accessService: new NotetakerAccessService({
        bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      }),
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      activityRepository: repositories.activityRepository,
      userRepository,
      summaryGenerator: generator,
      notetakerTasker: tasker,
      config: getNotetakerConfig({ NODE_ENV: "test", NOTETAKER_SUMMARY_MIN_WORDS: "5" }),
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedTranscript(
    params: { passages?: NotetakerPassageRecord[]; language?: string | null; dispatchedAt?: Date } = {}
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord }> {
    const passages = params.passages ?? buildEnoughPassages();
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      status: "READY",
      dispatchedAt: params.dispatchedAt ?? FIRST_DISPATCH,
    });
    const created = await repositories.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId: BOOKING_ID,
    });
    await repositories.transcriptRepository.insertPassages(created.id, passages);
    const transcript = await repositories.transcriptRepository.update(created.id, {
      language: params.language === undefined ? "pl" : params.language,
      passageCount: passages.length,
    });
    return { session, transcript };
  }

  async function seedSummary(
    transcriptId: string,
    params: { status: NotetakerSummaryStatusDto; failureCode?: string | null; attempts?: number }
  ): Promise<void> {
    const { summaryRepository } = repositories;
    await summaryRepository.upsertPending(transcriptId);
    for (let i = 0; i < (params.attempts ?? 0); i += 1) {
      await summaryRepository.incrementAttempts(transcriptId);
    }
    if (params.status === "READY") {
      await summaryRepository.saveResult(transcriptId, {
        status: "READY",
        language: "en",
        overview: "old overview",
        keyPoints: ["old point"],
        decisions: [],
        actionItems: [],
        model: "old-model",
        generatedAt: new Date("2026-09-01T10:00:00.000Z"),
      });
      return;
    }
    if (params.status === "FAILED" || params.status === "NOT_ENOUGH_CONTENT") {
      await summaryRepository.setStatus(transcriptId, params.status, params.failureCode ?? null);
    }
  }

  async function readSummary(transcriptId: string) {
    return repositories.summaryRepository.findByTranscriptId(transcriptId);
  }

  async function readActivities() {
    return repositories.activityRepository.findByBookingId({ bookingId: BOOKING_ID, limit: 50 });
  }

  function loggedText(): string {
    return JSON.stringify([
      logger.debug.mock.calls,
      logger.error.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
  }

  // JSON.stringify(new Error()) is "{}", so a leaked error object would pass a text-only check.
  function loggedArgs(): unknown[] {
    return [
      ...logger.debug.mock.calls.flat(),
      ...logger.error.mock.calls.flat(),
      ...logger.info.mock.calls.flat(),
      ...logger.warn.mock.calls.flat(),
    ];
  }

  async function catchMessage(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      return error instanceof Error ? error.message : "";
    }
    return "";
  }

  describe("generate", () => {
    it("returns quietly when the transcript does not exist", async () => {
      await expect(
        service.generate({ transcriptId: "missing", requestedByUserId: null })
      ).resolves.toBeUndefined();

      expect(generator.inputs).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
      expect(repositories.store.summaries.size).toBe(0);
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.anything(), { transcriptId: "missing" });
    });

    it("does not overwrite a READY summary", async () => {
      const { transcript } = await seedTranscript();
      await seedSummary(transcript.id, { status: "READY", attempts: 1 });
      const before = await readSummary(transcript.id);

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(await readSummary(transcript.id)).toEqual(before);
      expect(generator.inputs).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("leaves a NOT_ENOUGH_CONTENT summary untouched", async () => {
      const { transcript } = await seedTranscript();
      await seedSummary(transcript.id, { status: "NOT_ENOUGH_CONTENT", attempts: 1 });
      const before = await readSummary(transcript.id);

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(await readSummary(transcript.id)).toEqual(before);
      expect(generator.inputs).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("creates a missing row as PENDING and increments attempts", async () => {
      const { transcript } = await seedTranscript();
      let observed: Awaited<ReturnType<typeof readSummary>> = null;
      generator.onGenerate = async () => {
        observed = await readSummary(transcript.id);
      };

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(observed).toMatchObject({ status: "PENDING", attempts: 1, failureCode: null });
    });

    it("stores the result as READY", async () => {
      const { transcript } = await seedTranscript();

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "READY",
        language: "pl",
        overview: VALID_CONTENT.overview,
        keyPoints: VALID_CONTENT.keyPoints,
        decisions: VALID_CONTENT.decisions,
        actionItems: VALID_CONTENT.actionItems,
        model: "scripted-model",
        generatedAt: NOW,
        attempts: 1,
        failureCode: null,
      });
    });

    it("sends the whole transcript in index order and the stored transcript language as the hint", async () => {
      const passages = [
        buildPassage({ index: 2, text: "third passage here" }),
        buildPassage({ index: 0, text: "first passage here" }),
        buildPassage({ index: 1, text: "second passage here" }),
      ];
      const { transcript } = await seedTranscript({ passages, language: "pl" });

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(generator.inputs).toHaveLength(1);
      expect(generator.inputs[0].languageHint).toBe("pl");
      expect(generator.inputs[0].passages.map((passage) => passage.index)).toEqual([0, 1, 2]);

      const { transcript: noLanguage } = await seedTranscript({
        passages,
        language: null,
        dispatchedAt: SECOND_DISPATCH,
      });
      await service.generate({ transcriptId: noLanguage.id, requestedByUserId: null });

      expect(generator.inputs[1].languageHint).toBeNull();
    });

    it("sets NOT_ENOUGH_CONTENT below the minimum and makes no generator call", async () => {
      const { transcript } = await seedTranscript({ passages: buildTooFewPassages() });

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "NOT_ENOUGH_CONTENT",
        failureCode: null,
        attempts: 1,
      });
      expect(generator.inputs).toHaveLength(0);
    });

    it("notifies once when its own guard sets NOT_ENOUGH_CONTENT on an automatic run", async () => {
      const { session, transcript } = await seedTranscript({ passages: buildTooFewPassages() });

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(tasker.sendNotificationCalls).toEqual([
        {
          payload: { kind: "RESULTS_READY", bookingId: BOOKING_ID, sessionId: session.id },
          options: { idempotencyKey: `notetaker:RESULTS_READY:${session.id}` },
        },
      ]);

      const { transcript: requested } = await seedTranscript({
        passages: buildTooFewPassages(),
        dispatchedAt: SECOND_DISPATCH,
      });
      await service.generate({ transcriptId: requested.id, requestedByUserId: ORGANIZER_ID });

      expect((await readSummary(requested.id))?.status).toBe("NOT_ENOUGH_CONTENT");
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("calls the generator at exactly the minimum word count", async () => {
      const { transcript } = await seedTranscript({ passages: buildExactlyFiveWords() });

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(generator.inputs).toHaveLength(1);
      expect((await readSummary(transcript.id))?.status).toBe("READY");
    });

    it("leaves the session untouched on success and on failure", async () => {
      const { session, transcript } = await seedTranscript();
      const before = await repositories.sessionRepository.findById(session.id);

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });
      expect(await repositories.sessionRepository.findById(session.id)).toEqual(before);

      const { session: failedSession, transcript: failedTranscript } = await seedTranscript({
        dispatchedAt: SECOND_DISPATCH,
      });
      const failedBefore = await repositories.sessionRepository.findById(failedSession.id);
      generator.queue.push({ ok: false, failureCode: "REFUSED", retryable: false });

      await service.generate({ transcriptId: failedTranscript.id, requestedByUserId: null });

      expect((await readSummary(failedTranscript.id))?.status).toBe("FAILED");
      expect(await repositories.sessionRepository.findById(failedSession.id)).toEqual(failedBefore);
    });

    it("enqueues RESULTS_READY once with the session key when the first generation is READY", async () => {
      const { session, transcript } = await seedTranscript();

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(tasker.sendNotificationCalls).toEqual([
        {
          payload: { kind: "RESULTS_READY", bookingId: BOOKING_ID, sessionId: session.id },
          options: { idempotencyKey: `notetaker:RESULTS_READY:${session.id}` },
        },
      ]);

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("does not enqueue RESULTS_READY for a host re-request", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push({ ok: false, failureCode: "REFUSED", retryable: false });

      await service.generate({ transcriptId: transcript.id, requestedByUserId: ORGANIZER_ID });
      expect((await readSummary(transcript.id))?.status).toBe("FAILED");

      await service.generate({ transcriptId: transcript.id, requestedByUserId: ORGANIZER_ID });
      expect((await readSummary(transcript.id))?.status).toBe("READY");

      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("a refusal sets FAILED with its failure code, notifies and does not throw", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push({ ok: false, failureCode: "REFUSED", retryable: false });

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).resolves.toBeUndefined();

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "REFUSED",
        attempts: 1,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("a schema failure from the generator sets FAILED / INVALID_OUTPUT", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push({ ok: false, failureCode: "INVALID_OUTPUT", retryable: true });

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toBeInstanceOf(ErrorWithCode);

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "INVALID_OUTPUT",
      });
    });

    it("re-validates an ok result and treats invalid content as INVALID_OUTPUT, final", async () => {
      const { transcript } = await seedTranscript();
      // Models a generator that returns unvalidated data instead of a schema-checked model answer.
      const invalidContent: NotetakerSummaryContent = JSON.parse('{"language":"pl","overview":"x"}');
      generator.queue.push({ ok: true, content: invalidContent, model: "x" });

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).resolves.toBeUndefined();

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "INVALID_OUTPUT",
        overview: null,
        model: null,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("a retryable failure at attempt 1 and 2 throws after writing FAILED and does not notify", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push(RETRYABLE_PROVIDER_ERROR, RETRYABLE_PROVIDER_ERROR);

      const first = service.generate({ transcriptId: transcript.id, requestedByUserId: null });
      await expect(first).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(first).rejects.toMatchObject({
        code: ErrorCode.InternalServerError,
        message: `Notetaker summary generation for transcript ${transcript.id} failed with PROVIDER_ERROR (attempt 1 of 3)`,
      });
      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "PROVIDER_ERROR",
        attempts: 1,
      });

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toMatchObject({
        code: ErrorCode.InternalServerError,
        message: `Notetaker summary generation for transcript ${transcript.id} failed with PROVIDER_ERROR (attempt 2 of 3)`,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("a retryable failure at attempt 3 notifies and does not throw", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push(RETRYABLE_PROVIDER_ERROR, RETRYABLE_PROVIDER_ERROR, RETRYABLE_PROVIDER_ERROR);

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).resolves.toBeUndefined();

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        attempts: NOTETAKER_SUMMARY_MAX_ATTEMPTS,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("puts a FAILED row back to PENDING before the generator runs on a retry", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push(RETRYABLE_PROVIDER_ERROR);
      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toBeInstanceOf(ErrorWithCode);

      let observed: Awaited<ReturnType<typeof readSummary>> = null;
      generator.onGenerate = async () => {
        observed = await readSummary(transcript.id);
      };
      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(observed).toMatchObject({ status: "PENDING", failureCode: null, attempts: 2 });
    });

    it("a retry that succeeds stores READY and notifies once", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push(RETRYABLE_PROVIDER_ERROR);
      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).rejects.toBeInstanceOf(ErrorWithCode);

      await service.generate({ transcriptId: transcript.id, requestedByUserId: null });

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "READY",
        attempts: 2,
        failureCode: null,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("a generator throw maps to UNEXPECTED_ERROR and is retried", async () => {
      const { transcript } = await seedTranscript();
      generator.queue.push(new Error(`boom ${SECRET_TOKEN}`));

      const promise = service.generate({ transcriptId: transcript.id, requestedByUserId: null });
      const message = await catchMessage(promise);

      expect(message).toBe(
        `Notetaker summary generation for transcript ${transcript.id} failed with UNEXPECTED_ERROR (attempt 1 of 3)`
      );
      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "UNEXPECTED_ERROR",
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ errorName: "Error" })
      );
      expect(loggedText()).not.toContain(SECRET_TOKEN);
      expect(message).not.toContain(SECRET_TOKEN);
      expect(loggedArgs().some((arg) => arg instanceof Error)).toBe(false);
    });

    it("a re-request after a final FAILED gets one attempt and never throws for retry", async () => {
      const { transcript } = await seedTranscript();
      await seedSummary(transcript.id, { status: "FAILED", failureCode: "PROVIDER_ERROR", attempts: 3 });
      generator.queue.push(RETRYABLE_PROVIDER_ERROR);

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: ORGANIZER_ID })
      ).resolves.toBeUndefined();

      expect(await readSummary(transcript.id)).toMatchObject({ status: "FAILED", attempts: 4 });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("logs a task-failed RESULTS_READY enqueue and does not throw", async () => {
      const { session, transcript } = await seedTranscript();
      tasker.sendNotificationRunId = "task-failed";

      await expect(
        service.generate({ transcriptId: transcript.id, requestedByUserId: null })
      ).resolves.toBeUndefined();

      expect((await readSummary(transcript.id))?.status).toBe("READY");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.anything(), {
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
    });

    it("never puts passage or summary text in a log argument or a thrown message", async () => {
      const messages: string[] = [];

      const { transcript: ready } = await seedTranscript();
      await service.generate({ transcriptId: ready.id, requestedByUserId: null });

      const { transcript: tooFew } = await seedTranscript({
        passages: buildTooFewPassages(),
        dispatchedAt: new Date("2026-10-12T09:52:00.000Z"),
      });
      await service.generate({ transcriptId: tooFew.id, requestedByUserId: null });

      const { transcript: retryable } = await seedTranscript({
        dispatchedAt: new Date("2026-10-12T09:53:00.000Z"),
      });
      generator.queue.push(RETRYABLE_PROVIDER_ERROR);
      messages.push(
        await catchMessage(service.generate({ transcriptId: retryable.id, requestedByUserId: null }))
      );

      const { transcript: thrown } = await seedTranscript({
        dispatchedAt: new Date("2026-10-12T09:54:00.000Z"),
      });
      generator.queue.push(new Error(`boom ${SECRET_TOKEN}`));
      messages.push(
        await catchMessage(service.generate({ transcriptId: thrown.id, requestedByUserId: null }))
      );

      expect(messages.every((message) => message.length > 0)).toBe(true);
      expect(loggedText()).not.toContain(SECRET_TOKEN);
      expect(loggedText()).not.toContain(VALID_CONTENT.overview);
      for (const message of messages) {
        expect(message).not.toContain(SECRET_TOKEN);
      }
      expect(loggedArgs().some((arg) => arg instanceof Error)).toBe(false);
    });
  });

  describe("requestRegeneration", () => {
    it("is allowed when the summary is FAILED", async () => {
      const { transcript } = await seedTranscript();
      await seedSummary(transcript.id, { status: "FAILED", failureCode: "REFUSED", attempts: 3 });

      const result = await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result).toEqual({
        status: "PENDING",
        language: null,
        overview: null,
        keyPoints: [],
        decisions: [],
        actionItems: [],
        generatedAt: null,
      });
      expect(await readSummary(transcript.id)).toMatchObject({
        status: "PENDING",
        failureCode: null,
        attempts: 3,
      });
    });

    it("is allowed when no summary row exists while a transcript does", async () => {
      const { transcript } = await seedTranscript();

      const result = await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result.status).toBe("PENDING");
      expect(await readSummary(transcript.id)).toMatchObject({ status: "PENDING", attempts: 0 });
    });

    it.each<NotetakerSummaryStatusDto>([
      "PENDING",
      "READY",
      "NOT_ENOUGH_CONTENT",
    ])("rejects a %s summary with BadRequest", async (status) => {
      const { transcript } = await seedTranscript();
      await seedSummary(transcript.id, { status, attempts: 1 });
      const before = await readSummary(transcript.id);

      const promise = service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
        message: `Summary of booking ${BOOKING_UID} is ${status} and cannot be regenerated`,
      });
      expect(await readSummary(transcript.id)).toEqual(before);
      expect(await readActivities()).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("rejects with NotFound when the booking has no transcript", async () => {
      const expected = {
        code: ErrorCode.NotFound,
        message: `Booking ${BOOKING_UID} has no notetaker transcript`,
      };

      await expect(
        service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID })
      ).rejects.toMatchObject(expected);

      await repositories.sessionRepository.create({
        bookingId: BOOKING_ID,
        platform: "GOOGLE_MEET",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        botProvider: "FAKE",
        displayName: "Notetaker",
        scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      });

      const promise = service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });
      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject(expected);
      expect(await readActivities()).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("rejects with NotFound when the results were deleted", async () => {
      const { session, transcript } = await seedTranscript();
      await repositories.sessionRepository.setResultsDeletedAtByIds(
        [session.id],
        new Date("2026-10-13T10:00:00.000Z")
      );

      const promise = service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({
        code: ErrorCode.NotFound,
        message: `Results of notetaker session ${session.id} have been deleted`,
      });
      expect(await readSummary(transcript.id)).toBeNull();
      expect(await readActivities()).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("rejects a non-host with Forbidden", async () => {
      const { transcript } = await seedTranscript();

      const promise = service.requestRegeneration({ bookingUid: BOOKING_UID, userId: STRANGER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      expect(await readSummary(transcript.id)).toBeNull();
      expect(await readActivities()).toHaveLength(0);
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("rejects an unknown booking uid with NotFound", async () => {
      await seedTranscript();

      const promise = service.requestRegeneration({ bookingUid: "unknown-uid", userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      expect(tasker.generateSummaryCalls).toHaveLength(0);
    });

    it("uses the newest session that has a transcript", async () => {
      await seedTranscript({ dispatchedAt: FIRST_DISPATCH });
      const newer = await seedTranscript({ dispatchedAt: SECOND_DISPATCH });

      await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(tasker.generateSummaryCalls.map((call) => call.payload.transcriptId)).toEqual([
        newer.transcript.id,
      ]);
      const activities = await readActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0].sessionId).toBe(newer.session.id);
    });

    it("writes a SUMMARY_REQUESTED activity with the requesting user's name", async () => {
      const { session } = await seedTranscript();

      await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      const activities = await readActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        bookingId: BOOKING_ID,
        sessionId: session.id,
        action: "SUMMARY_REQUESTED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: "Olga Organizer",
        detail: null,
      });
    });

    it("writes a null actor name when the user is not found", async () => {
      await seedTranscript();
      users = [];

      await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      const activities = await readActivities();
      expect(activities).toHaveLength(1);
      expect(activities[0].actorName).toBeNull();
    });

    it("enqueues generateSummary with the requesting user's id and no options", async () => {
      const { transcript } = await seedTranscript();

      await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(tasker.generateSummaryCalls).toEqual([
        {
          payload: { transcriptId: transcript.id, requestedByUserId: ORGANIZER_ID },
          options: undefined,
        },
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("returns PENDING even when the tasker already finished the generation inline", async () => {
      const { transcript } = await seedTranscript();
      tasker.onGenerateSummary = async () => {
        await repositories.summaryRepository.saveResult(transcript.id, {
          status: "READY",
          language: "pl",
          overview: VALID_CONTENT.overview,
          keyPoints: VALID_CONTENT.keyPoints,
          decisions: VALID_CONTENT.decisions,
          actionItems: VALID_CONTENT.actionItems,
          model: "scripted-model",
          generatedAt: NOW,
        });
      };

      const result = await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result.status).toBe("PENDING");
      expect((await readSummary(transcript.id))?.status).toBe("READY");
    });

    it("sets FAILED / ENQUEUE_FAILED and throws when the enqueue fails", async () => {
      const { transcript } = await seedTranscript();
      tasker.generateSummaryRunId = "task-failed";

      const promise = service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({
        code: ErrorCode.InternalServerError,
        message: `Could not queue the notetaker summary generation for booking ${BOOKING_UID}`,
      });
      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "ENQUEUE_FAILED",
      });
      expect(logger.error).toHaveBeenCalled();
      expect(await readActivities()).toHaveLength(1);

      tasker.generateSummaryRunId = "run-summary";
      const retry = await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(retry.status).toBe("PENDING");
    });

    it("keeps the row's own failure when the inline run already failed", async () => {
      const { transcript } = await seedTranscript();
      tasker.generateSummaryRunId = "task-failed";
      tasker.onGenerateSummary = async () => {
        await repositories.summaryRepository.setStatus(transcript.id, "FAILED", "PROVIDER_ERROR");
      };

      await expect(
        service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID })
      ).rejects.toMatchObject({ code: ErrorCode.InternalServerError });

      expect(await readSummary(transcript.id)).toMatchObject({
        status: "FAILED",
        failureCode: "PROVIDER_ERROR",
      });
    });

    it("does not log the user's name or email", async () => {
      const { transcript } = await seedTranscript();

      await service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });
      expect(loggedText()).not.toContain("Olga Organizer");
      expect(loggedText()).not.toContain("organizer@example.com");

      // The first request left the row PENDING, which a second request would reject.
      await repositories.summaryRepository.setStatus(transcript.id, "FAILED", "PROVIDER_ERROR");
      tasker.generateSummaryRunId = "task-failed";
      await expect(
        service.requestRegeneration({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID })
      ).rejects.toBeInstanceOf(ErrorWithCode);

      expect((await readSummary(transcript.id))?.status).toBe("FAILED");
      expect(logger.error).toHaveBeenCalled();
      expect(loggedText()).not.toContain("Olga Organizer");
      expect(loggedText()).not.toContain("organizer@example.com");
    });
  });
});
