import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import type { NotetakerActivityActionDto, NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type {
  NotetakerExportDto,
  NotetakerTranscriptCompletenessDto,
} from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { NotetakerActivityRecord } from "../repositories/interfaces/INotetakerActivityRepository";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE, NotetakerAccessService } from "./NotetakerAccessService";
import { NOTETAKER_ACTIVITY_LIMIT, NotetakerResultsService } from "./NotetakerResultsService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(
    async (_locale: string, _namespace: string) => (key: string, vars?: Record<string, unknown>) => {
      if (!vars) return key;
      return `${key}:${JSON.stringify(vars)}`;
    }
  ),
}));

const NOW = new Date("2026-10-12T11:00:00.000Z");
const DELETED_AT = new Date("2026-10-13T08:00:00.000Z");

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const OTHER_BOOKING_ID = 101;
const OTHER_BOOKING_UID = "booking-uid-2";
const ORGANIZER_ID = 1;
const CO_HOST_ID = 2;
const ATTENDEE_USER_ID = 3;
const STRANGER_ID = 5;

const ORGANIZER_EMAIL = "organizer@example.com";
const CO_HOST_EMAIL = "cohost@example.com";
const ATTENDEE_EMAIL = "attendee@example.com";

const ORGANIZER_NAME = "Olivia Organizer";
const CO_HOST_NAME = "Carl Cohost";
const ATTENDEE_NAME = "Anna Attendee";

const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const EXPORT_FILENAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}\.md$/;
const SHARED_NOTICE_ENQUEUE_FAILED = "Failed to enqueue the notetaker shared notice";

// The export escapes Markdown punctuation, so a sentinel holding "-", "." or "_" could leak
// unnoticed in its escaped form. These are letters only.
const SPEAKER_KEY_SENTINEL = "SPEAKERKEYSENTINEL";
const BOOKING_UID_SENTINEL = "BOOKINGUIDSENTINEL";
const OTHER_PASSAGE_SENTINEL = "OTHERBOOKINGPASSAGE";
const OTHER_OVERVIEW_SENTINEL = "OTHERBOOKINGOVERVIEW";

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
    attendeeEmails: [ATTENDEE_EMAIL],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: ORGANIZER_EMAIL, locale: "en" },
    ...overrides,
  };
}

function buildPassages(
  count: number,
  startIndex: number = 0,
  textPrefix: string = "passage"
): NotetakerPassageRecord[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return {
      index,
      speakerKey: "speaker-1",
      speakerName: "Ada",
      unknownSpeakerNumber: null,
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      text: `${textPrefix} ${index}`,
      language: "en",
    };
  });
}

function indexesOf(result: { passages: { index: number }[] }): number[] {
  return result.passages.map((passage) => passage.index);
}

function buildCoHostBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return buildBooking({
    attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
    eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
    ...overrides,
  });
}

function buildUser(id: number, overrides: Partial<NotetakerUserRecord> = {}): NotetakerUserRecord {
  return {
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    locale: "en",
    timeZone: "UTC",
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<ErrorWithCode> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ErrorWithCode)) throw error;
    return error;
  }
  throw new Error("Expected the promise to reject");
}

class RecordingNotetakerTasker implements INotetakerTasker {
  sendNotificationCalls: {
    payload: NotetakerSendNotificationPayload;
    options: TriggerOptions | undefined;
  }[] = [];
  sendNotificationRunId = "run-1";
  onSendNotification: () => void = () => undefined;

  async finalizeSession(_payload: NotetakerFinalizeSessionPayload): Promise<{ runId: string }> {
    return { runId: "run-finalize" };
  }

  async generateSummary(_payload: NotetakerGenerateSummaryPayload): Promise<{ runId: string }> {
    return { runId: "run-summary" };
  }

  async sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    this.onSendNotification();
    this.sendNotificationCalls.push({ payload, options });
    return { runId: this.sendNotificationRunId };
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

type HostOnlyCall = (params: { bookingUid: string; userId: number }) => Promise<unknown>;

describe("NotetakerResultsService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let service: NotetakerResultsService;
  let users: NotetakerUserRecord[];
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let tasker: RecordingNotetakerTasker;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(getTranslation).mockClear();
    users = [
      buildUser(ORGANIZER_ID, { name: ORGANIZER_NAME, email: ORGANIZER_EMAIL }),
      buildUser(CO_HOST_ID, {
        name: CO_HOST_NAME,
        email: CO_HOST_EMAIL,
        locale: "de",
        timeZone: "Europe/Berlin",
      }),
      buildUser(ATTENDEE_USER_ID, { name: ATTENDEE_NAME, email: ATTENDEE_EMAIL, locale: null }),
    ];
    repositories = createInMemoryNotetakerRepositories();
    tasker = new RecordingNotetakerTasker();
    logger = createLogger();
    const {
      bookingNotetakerRepository,
      sessionRepository,
      transcriptRepository,
      summaryRepository,
      activityRepository,
    } = repositories;
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    const accessService = new NotetakerAccessService({
      bookingNotetakerRepository,
      sessionRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
    });
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
    };
    service = new NotetakerResultsService({
      accessService,
      bookingNotetakerRepository,
      sessionRepository,
      transcriptRepository,
      summaryRepository,
      activityRepository,
      userRepository,
      notetakerTasker: tasker,
      logger,
    });
    repositories.store.addBooking(buildBooking());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedSessionWithTranscript(
    options: {
      bookingId?: number;
      dispatchedAt?: Date;
      withTranscript?: boolean;
      colleagueSharingDisclosed?: boolean;
      passages?: NotetakerPassageRecord[];
    } = {}
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord | null }> {
    const bookingId = options.bookingId ?? BOOKING_ID;
    const session = await repositories.sessionRepository.create({
      bookingId,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      dispatchedAt: options.dispatchedAt ?? new Date("2026-10-12T09:55:00.000Z"),
      colleagueSharingDisclosed: options.colleagueSharingDisclosed,
    });
    if (options.withTranscript === false) return { session, transcript: null };

    const transcript = await repositories.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId,
    });
    if (options.passages) {
      await repositories.transcriptRepository.insertPassages(transcript.id, options.passages);
    }
    return { session, transcript };
  }

  // seedSessionWithTranscript leaves the session SCHEDULED, which is live: results of such a booking
  // cannot be deleted. These seeders default to a terminal status and a complete transcript.
  async function seedSessionWithoutTranscript(
    options: {
      bookingId?: number;
      dispatchedAt?: Date;
      status?: NotetakerSessionStatusDto;
      outcomeReason?: NotetakerOutcomeReasonDto | null;
      colleagueSharingDisclosed?: boolean;
    } = {}
  ): Promise<NotetakerSessionRecord> {
    return repositories.sessionRepository.create({
      bookingId: options.bookingId ?? BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_LINK,
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      dispatchedAt: options.dispatchedAt ?? new Date("2026-10-12T09:55:00.000Z"),
      status: options.status ?? "READY",
      outcomeReason: options.outcomeReason ?? null,
      colleagueSharingDisclosed: options.colleagueSharingDisclosed,
    });
  }

  async function seedFinishedSession(
    options: {
      bookingId?: number;
      dispatchedAt?: Date;
      status?: NotetakerSessionStatusDto;
      outcomeReason?: NotetakerOutcomeReasonDto | null;
      completeness?: NotetakerTranscriptCompletenessDto;
      colleagueSharingDisclosed?: boolean;
      passages?: NotetakerPassageRecord[];
    } = {}
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord }> {
    const session = await seedSessionWithoutTranscript(options);
    const created = await repositories.transcriptRepository.createIfMissing({
      sessionId: session.id,
      bookingId: session.bookingId,
    });
    if (options.passages) {
      await repositories.transcriptRepository.insertPassages(created.id, options.passages);
    }
    const transcript = await repositories.transcriptRepository.update(created.id, {
      completeness: options.completeness ?? "COMPLETE",
    });
    return { session, transcript };
  }

  // Every status other than READY keeps the saved text, so a leak of it into the export is visible.
  async function seedSummary(
    transcriptId: string,
    overview: string,
    status: NotetakerSummaryStatusDto = "READY"
  ): Promise<void> {
    const { summaryRepository } = repositories;
    await summaryRepository.upsertPending(transcriptId);
    await summaryRepository.saveResult(transcriptId, {
      status: "READY",
      language: "en",
      overview,
      keyPoints: [`${overview}KEYPOINT`],
      decisions: [`${overview}DECISION`],
      actionItems: [{ text: `${overview}ACTIONITEM`, owner: null }],
      model: "test-model",
      generatedAt: NOW,
    });
    if (status === "READY") return;
    let failureCode: string | null = null;
    if (status === "FAILED") failureCode = "PROVIDER_ERROR";
    await summaryRepository.setStatus(transcriptId, status, failureCode);
  }

  async function grantAttendee(bookingId: number = BOOKING_ID): Promise<void> {
    repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
    await repositories.bookingNotetakerRepository.createSharingGrant({
      bookingId,
      grantedByUserId: ORGANIZER_ID,
    });
  }

  async function recordActivity(
    overrides: Partial<Omit<NotetakerActivityRecord, "id" | "createdAt">> = {}
  ): Promise<NotetakerActivityRecord> {
    return repositories.activityRepository.create({
      bookingId: BOOKING_ID,
      sessionId: null,
      action: "ENABLED",
      actorType: "USER",
      actorUserId: ORGANIZER_ID,
      actorName: ORGANIZER_NAME,
      detail: null,
      ...overrides,
    });
  }

  function activitiesOf(bookingId: number = BOOKING_ID): NotetakerActivityRecord[] {
    return repositories.store.activities.filter((activity) => activity.bookingId === bookingId);
  }

  function actionsOf(bookingId: number = BOOKING_ID): NotetakerActivityActionDto[] {
    return activitiesOf(bookingId).map((activity) => activity.action);
  }

  function snapshotWrites(): {
    activities: number;
    transcripts: number;
    passageSets: number;
    summaries: number;
    grants: number;
    stampedSessions: number;
    enqueues: number;
  } {
    const { store } = repositories;
    return {
      activities: store.activities.length,
      transcripts: store.transcripts.size,
      passageSets: store.passages.size,
      summaries: store.summaries.size,
      grants: store.sharingGrants.size,
      stampedSessions: Array.from(store.sessions.values()).filter(
        (session) => session.resultsDeletedAt !== null
      ).length,
      enqueues: tasker.sendNotificationCalls.length,
    };
  }

  function loggedText(): string {
    return JSON.stringify([
      logger.debug.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
  }

  // The role is checked in the service, so each host-only method gets the same refusals.
  function itRefusesEveryoneButAHost(call: HostOnlyCall): void {
    it("refuses a granted attendee", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();
      const before = snapshotWrites();

      const error = await captureError(call({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID }));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(snapshotWrites()).toEqual(before);
    });

    it("refuses an attendee without a grant", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      const before = snapshotWrites();

      const error = await captureError(call({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID }));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(snapshotWrites()).toEqual(before);
    });

    it("refuses an unrelated user", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();
      const before = snapshotWrites();

      const error = await captureError(call({ bookingUid: BOOKING_UID, userId: STRANGER_ID }));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(snapshotWrites()).toEqual(before);
    });

    it("refuses an unrelated user with Forbidden when the booking has no transcript", async () => {
      const error = await captureError(call({ bookingUid: BOOKING_UID, userId: STRANGER_ID }));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects an unknown booking uid for a host and for an unrelated user alike", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      const before = snapshotWrites();

      const asHost = await captureError(call({ bookingUid: "missing-uid", userId: ORGANIZER_ID }));
      const asStranger = await captureError(call({ bookingUid: "missing-uid", userId: STRANGER_ID }));

      expect(asHost.code).toBe(ErrorCode.NotFound);
      expect(asStranger.code).toBe(ErrorCode.NotFound);
      expect(snapshotWrites()).toEqual(before);
    });
  }

  describe("listPassages", () => {
    it("returns passages ordered by index for the host", async () => {
      const passages = buildPassages(3);
      await seedSessionWithTranscript({ passages: [passages[2], passages[0], passages[1]] });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(indexesOf(result)).toEqual([0, 1, 2]);
      expect(result.nextCursor).toBeNull();
    });

    it("maps rows to DTOs without the speaker key", async () => {
      await seedSessionWithTranscript({
        passages: [
          {
            index: 0,
            speakerKey: "speaker-1",
            speakerName: "Ada",
            unknownSpeakerNumber: null,
            startMs: 0,
            endMs: 900,
            text: "Hello there",
            language: "en",
          },
          {
            index: 1,
            speakerKey: "speaker-2",
            speakerName: null,
            unknownSpeakerNumber: 1,
            startMs: 1000,
            endMs: 1800,
            text: "Cześć",
            language: "pl",
          },
        ],
      });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result.passages).toEqual([
        {
          index: 0,
          speakerName: "Ada",
          unknownSpeakerNumber: null,
          startMs: 0,
          endMs: 900,
          text: "Hello there",
          language: "en",
        },
        {
          index: 1,
          speakerName: null,
          unknownSpeakerNumber: 1,
          startMs: 1000,
          endMs: 1800,
          text: "Cześć",
          language: "pl",
        },
      ]);
    });

    it("defaults the limit to 200", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(250) });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result.passages).toHaveLength(200);
      expect(result.nextCursor).toBe(199);
    });

    it("caps the limit at 500", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(600) });

      const result = await service.listPassages({
        bookingUid: BOOKING_UID,
        userId: ORGANIZER_ID,
        limit: 1000,
      });

      expect(result.passages).toHaveLength(500);
      expect(result.nextCursor).toBe(499);
    });

    it("raises a limit below 1 to 1", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(3) });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID, limit: 0 });

      expect(result.passages).toHaveLength(1);
      expect(result.nextCursor).toBe(0);
    });

    it("treats the cursor as exclusive and walks to the end", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(5) });
      const base = { bookingUid: BOOKING_UID, userId: ORGANIZER_ID, limit: 2 };

      const first = await service.listPassages(base);
      expect(indexesOf(first)).toEqual([0, 1]);
      expect(first.nextCursor).toBe(1);

      const second = await service.listPassages({ ...base, cursor: first.nextCursor });
      expect(indexesOf(second)).toEqual([2, 3]);
      expect(second.nextCursor).toBe(3);

      const third = await service.listPassages({ ...base, cursor: second.nextCursor });
      expect(indexesOf(third)).toEqual([4]);
      expect(third.nextCursor).toBeNull();

      const withNullCursor = await service.listPassages({ ...base, cursor: null });
      expect(withNullCursor).toEqual(first);
    });

    it("returns no next cursor when the last page fits exactly", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(4) });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID, limit: 4 });

      expect(result.passages).toHaveLength(4);
      expect(result.nextCursor).toBeNull();
    });

    it("returns an empty page for a transcript without passages", async () => {
      await seedSessionWithTranscript();

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result).toEqual({ passages: [], nextCursor: null });
    });

    describe("session selection", () => {
      it("uses the newest session with a transcript when sessionId is omitted", async () => {
        await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
          passages: buildPassages(1, 0, "older"),
        });
        await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
          passages: buildPassages(1, 0, "newer"),
        });

        const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        expect(result.passages.map((passage) => passage.text)).toEqual(["newer 0"]);
      });

      it("skips a newer session that has no transcript", async () => {
        await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
          passages: buildPassages(1, 0, "older"),
        });
        await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
          withTranscript: false,
        });

        const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        expect(result.passages.map((passage) => passage.text)).toEqual(["older 0"]);
      });

      it("selects an explicit session even when it is not the latest", async () => {
        const older = await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
          passages: buildPassages(1, 0, "older"),
        });
        await seedSessionWithTranscript({
          dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
          passages: buildPassages(1, 0, "newer"),
        });

        const result = await service.listPassages({
          bookingUid: BOOKING_UID,
          sessionId: older.session.id,
          userId: ORGANIZER_ID,
        });

        expect(result.passages.map((passage) => passage.text)).toEqual(["older 0"]);
      });

      it("rejects an explicit session of another booking", async () => {
        repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: OTHER_BOOKING_UID }));
        const other = await seedSessionWithTranscript({
          bookingId: OTHER_BOOKING_ID,
          passages: buildPassages(1),
        });

        const promise = service.listPassages({
          bookingUid: BOOKING_UID,
          sessionId: other.session.id,
          userId: ORGANIZER_ID,
        });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects an unknown session id", async () => {
        const promise = service.listPassages({
          bookingUid: BOOKING_UID,
          sessionId: "00000000-0000-4000-8000-ffffffffffff",
          userId: ORGANIZER_ID,
        });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects an explicit session without a transcript", async () => {
        const seeded = await seedSessionWithTranscript({ withTranscript: false });

        const promise = service.listPassages({
          bookingUid: BOOKING_UID,
          sessionId: seeded.session.id,
          userId: ORGANIZER_ID,
        });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects when the booking has no sessions", async () => {
        const promise = service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects when the only session has no transcript", async () => {
        await seedSessionWithTranscript({ withTranscript: false });

        const promise = service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects deleted results with the session id omitted", async () => {
        const seeded = await seedSessionWithTranscript({ passages: buildPassages(2) });
        await repositories.sessionRepository.setResultsDeletedAtByIds(
          [seeded.session.id],
          new Date("2026-10-13T10:00:00.000Z")
        );

        const promise = service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });

      it("rejects deleted results with an explicit session id", async () => {
        const seeded = await seedSessionWithTranscript({ passages: buildPassages(2) });
        await repositories.sessionRepository.setResultsDeletedAtByIds(
          [seeded.session.id],
          new Date("2026-10-13T10:00:00.000Z")
        );

        const promise = service.listPassages({
          bookingUid: BOOKING_UID,
          sessionId: seeded.session.id,
          userId: ORGANIZER_ID,
        });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });
    });

    describe("access", () => {
      it("rejects an unrelated user although a transcript exists", async () => {
        await seedSessionWithTranscript({ passages: buildPassages(2) });

        const promise = service.listPassages({ bookingUid: BOOKING_UID, userId: STRANGER_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      });

      it("lets a granted attendee read the host's passages and re-checks the role on every call", async () => {
        const { store, bookingNotetakerRepository } = repositories;
        await seedSessionWithTranscript({ passages: buildPassages(3) });
        store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
        await bookingNotetakerRepository.createSharingGrant({
          bookingId: BOOKING_ID,
          grantedByUserId: ORGANIZER_ID,
        });

        const hostResult = await service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });
        const attendeeResult = await service.listPassages({
          bookingUid: BOOKING_UID,
          userId: ATTENDEE_USER_ID,
        });
        expect(attendeeResult).toEqual(hostResult);

        await bookingNotetakerRepository.deleteSharingGrant(BOOKING_ID);

        const promise = service.listPassages({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });
        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
      });

      it("rejects an unknown booking uid", async () => {
        const promise = service.listPassages({ bookingUid: "missing-uid", userId: ORGANIZER_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
      });
    });
  });

  const TEAM_ID = 50;
  const COLLEAGUE_ID = 7;

  function makeColleagueShared(): void {
    repositories.store.addBooking(buildBooking({ teamId: TEAM_ID }));
    repositories.store.setSharingMode(10, "TEAM");
    membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
  }

  function expectHostOnlyDenied(promise: Promise<unknown>): Promise<void> {
    return expect(promise).rejects.toMatchObject({
      code: ErrorCode.Forbidden,
      message: "Only a host of this booking can perform this action",
    });
  }

  describe("shared viewer", () => {
    beforeEach(() => {
      makeColleagueShared();
    });

    it("lists passages from the disclosed session", async () => {
      await seedFinishedSession({ colleagueSharingDisclosed: true, passages: buildPassages(2) });

      const result = await service.listPassages({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

      expect(indexesOf(result)).toEqual([0, 1]);
    });

    it("exports and records an EXPORTED row for the viewer", async () => {
      const seeded = await seedFinishedSession({
        colleagueSharingDisclosed: true,
        passages: buildPassages(2),
      });

      const result = await service.export({
        bookingUid: BOOKING_UID,
        format: "markdown",
        userId: COLLEAGUE_ID,
      });

      expect(result.mimeType).toBe("text/markdown");
      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        sessionId: seeded.session.id,
        action: "EXPORTED",
        actorUserId: COLLEAGUE_ID,
      });
    });

    it("refuses an explicit sessionId of an undisclosed earlier session", async () => {
      const earlier = await seedFinishedSession({
        colleagueSharingDisclosed: false,
        dispatchedAt: new Date("2026-10-12T08:00:00.000Z"),
        passages: buildPassages(2),
      });
      await seedFinishedSession({
        colleagueSharingDisclosed: true,
        dispatchedAt: new Date("2026-10-12T09:55:00.000Z"),
        passages: buildPassages(2),
      });

      const promise = service.listPassages({
        bookingUid: BOOKING_UID,
        sessionId: earlier.session.id,
        userId: COLLEAGUE_ID,
      });

      await expect(promise).rejects.toMatchObject({
        code: ErrorCode.Forbidden,
        message: NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE,
      });
    });

    it("refuses setSharing, deleteResults and getActivity with the host-only error", async () => {
      await seedFinishedSession({ colleagueSharingDisclosed: true, passages: buildPassages(2) });
      const before = snapshotWrites();

      await expectHostOnlyDenied(
        service.setSharing({ bookingUid: BOOKING_UID, shared: true, userId: COLLEAGUE_ID })
      );
      await expectHostOnlyDenied(service.deleteResults({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID }));
      await expectHostOnlyDenied(service.getActivity({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID }));
      expect(snapshotWrites()).toEqual(before);
    });
  });

  describe("setSharing", () => {
    function share(userId: number = ORGANIZER_ID): Promise<{ sharedWithAttendees: boolean }> {
      return service.setSharing({ bookingUid: BOOKING_UID, shared: true, userId });
    }

    function revoke(userId: number = ORGANIZER_ID): Promise<{ sharedWithAttendees: boolean }> {
      return service.setSharing({ bookingUid: BOOKING_UID, shared: false, userId });
    }

    describe("access when sharing", () => {
      itRefusesEveryoneButAHost((params) => service.setSharing({ ...params, shared: true }));
    });

    describe("access when revoking", () => {
      itRefusesEveryoneButAHost((params) => service.setSharing({ ...params, shared: false }));
    });

    it("lets an event-type co-host who is an attendee share", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(2) });

      const result = await share(CO_HOST_ID);

      expect(result).toEqual({ sharedWithAttendees: true });
      expect(repositories.store.sharingGrants.get(BOOKING_ID)?.grantedByUserId).toBe(CO_HOST_ID);
      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        action: "SHARED",
        actorUserId: CO_HOST_ID,
        actorName: CO_HOST_NAME,
      });
    });

    it("creates the grant, records SHARED with the actor's name and then enqueues the notice", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      const activityCountsAtEnqueue: number[] = [];
      tasker.onSendNotification = () => {
        activityCountsAtEnqueue.push(repositories.store.activities.length);
      };

      const result = await share();

      expect(result).toEqual({ sharedWithAttendees: true });
      expect(repositories.store.sharingGrants.get(BOOKING_ID)).toEqual({
        bookingId: BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
        grantedAt: NOW,
      });
      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        bookingId: BOOKING_ID,
        sessionId: null,
        action: "SHARED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: ORGANIZER_NAME,
        detail: null,
        createdAt: NOW,
      });
      expect(tasker.sendNotificationCalls).toEqual([
        {
          payload: { kind: "SHARED_WITH_ATTENDEES", bookingId: BOOKING_ID, sessionId: null },
          options: undefined,
        },
      ]);
      expect(activityCountsAtEnqueue).toEqual([1]);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("records a null actor name when the user lookup does not return the actor", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      users = [];

      await share();

      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        action: "SHARED",
        actorUserId: ORGANIZER_ID,
        actorName: null,
      });
    });

    it("allows sharing while the session is still live, as soon as a transcript exists", async () => {
      await seedSessionWithTranscript({ passages: buildPassages(1) });

      await expect(share()).resolves.toEqual({ sharedWithAttendees: true });

      expect(repositories.store.sharingGrants.has(BOOKING_ID)).toBe(true);
      expect(actionsOf()).toEqual(["SHARED"]);
    });

    it("refuses to share a booking without a session", async () => {
      const error = await captureError(share());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(repositories.store.sharingGrants.size).toBe(0);
      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("refuses to share when the only session has no transcript", async () => {
      await seedSessionWithoutTranscript({ status: "FAILED", outcomeReason: "NOT_ADMITTED" });

      const error = await captureError(share());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(repositories.store.sharingGrants.size).toBe(0);
      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("refuses to share results that were deleted", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(2) });
      await repositories.sessionRepository.setResultsDeletedAtByIds([seeded.session.id], DELETED_AT);

      const error = await captureError(share());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(repositories.store.sharingGrants.size).toBe(0);
      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("returns shared for a repeat and writes nothing more", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(2) });
      await share();
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      const repeat = await share();
      const byAnotherHost = await share(CO_HOST_ID);

      expect(repeat).toEqual({ sharedWithAttendees: true });
      expect(byAnotherHost).toEqual({ sharedWithAttendees: true });
      expect(actionsOf()).toEqual(["SHARED"]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
      expect(repositories.store.sharingGrants.get(BOOKING_ID)).toEqual({
        bookingId: BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
        grantedAt: NOW,
      });
    });

    it("writes one SHARED row and one notice when two hosts share at the same time", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(2) });

      const results = await Promise.all([share(ORGANIZER_ID), share(CO_HOST_ID)]);

      expect(results).toEqual([{ sharedWithAttendees: true }, { sharedWithAttendees: true }]);
      expect(actionsOf()).toEqual(["SHARED"]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
      const grant = repositories.store.sharingGrants.get(BOOKING_ID);
      expect(grant).toBeDefined();
      expect(activitiesOf()[0].actorUserId).toBe(grant?.grantedByUserId);
    });

    it("deletes the grant, records SHARING_REVOKED and enqueues nothing when sharing is stopped", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await share();
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      const result = await revoke();

      expect(result).toEqual({ sharedWithAttendees: false });
      expect(repositories.store.sharingGrants.has(BOOKING_ID)).toBe(false);
      expect(actionsOf()).toEqual(["SHARED", "SHARING_REVOKED"]);
      expect(activitiesOf()[1]).toMatchObject({
        bookingId: BOOKING_ID,
        sessionId: null,
        action: "SHARING_REVOKED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: ORGANIZER_NAME,
        detail: null,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("succeeds and writes nothing for a second revoke", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await share();
      await revoke();

      await expect(revoke()).resolves.toEqual({ sharedWithAttendees: false });

      expect(actionsOf()).toEqual(["SHARED", "SHARING_REVOKED"]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("writes one SHARING_REVOKED row when two hosts revoke at the same time", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(2) });
      await share();

      const results = await Promise.all([revoke(ORGANIZER_ID), revoke(CO_HOST_ID)]);

      expect(results).toEqual([{ sharedWithAttendees: false }, { sharedWithAttendees: false }]);
      expect(actionsOf()).toEqual(["SHARED", "SHARING_REVOKED"]);
    });

    it("succeeds and writes nothing when revoking a booking that was never shared", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });

      await expect(revoke()).resolves.toEqual({ sharedWithAttendees: false });

      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("succeeds when revoking a booking that has no transcript at all", async () => {
      await expect(revoke()).resolves.toEqual({ sharedWithAttendees: false });

      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("records two SHARED rows and two notices for share, revoke, share", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });

      await share();
      await revoke();
      const again = await share();

      expect(again).toEqual({ sharedWithAttendees: true });
      expect(actionsOf()).toEqual(["SHARED", "SHARING_REVOKED", "SHARED"]);
      expect(tasker.sendNotificationCalls).toHaveLength(2);
      expect(tasker.sendNotificationCalls.map((call) => call.payload.kind)).toEqual([
        "SHARED_WITH_ATTENDEES",
        "SHARED_WITH_ATTENDEES",
      ]);
      expect(repositories.store.sharingGrants.has(BOOKING_ID)).toBe(true);
    });

    it("logs a failed notice enqueue and still reports the booking as shared", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      tasker.sendNotificationRunId = "task-failed";

      await expect(share()).resolves.toEqual({ sharedWithAttendees: true });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(SHARED_NOTICE_ENQUEUE_FAILED, { bookingId: BOOKING_ID });
      expect(repositories.store.sharingGrants.has(BOOKING_ID)).toBe(true);
      expect(actionsOf()).toEqual(["SHARED"]);
      const logged = loggedText();
      expect(logged).not.toContain("@");
      expect(logged).not.toContain(ORGANIZER_NAME);
      expect(logged).not.toContain("Planning call");
      expect(logged).not.toContain("passage");
    });

    it("locks the attendee out of the passages and the export as soon as sharing is stopped", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await share();
      const whileShared = await service.listPassages({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });
      expect(indexesOf(whileShared)).toEqual([0, 1]);

      await revoke();
      const activityCount = repositories.store.activities.length;

      const listError = await captureError(
        service.listPassages({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID })
      );
      const exportError = await captureError(
        service.export({ bookingUid: BOOKING_UID, format: "markdown", userId: ATTENDEE_USER_ID })
      );
      expect(listError.code).toBe(ErrorCode.Forbidden);
      expect(exportError.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(activityCount);
    });
  });

  describe("deleteResults", () => {
    function deleteAs(userId: number = ORGANIZER_ID): Promise<void> {
      return service.deleteResults({ bookingUid: BOOKING_UID, userId });
    }

    describe("access", () => {
      itRefusesEveryoneButAHost((params) => service.deleteResults(params));
    });

    it("lets an event-type co-host who is an attendee delete", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(2) });

      await expect(deleteAs(CO_HOST_ID)).resolves.toBeUndefined();

      expect(repositories.store.transcripts.size).toBe(0);
      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        action: "DELETED",
        actorUserId: CO_HOST_ID,
        actorName: CO_HOST_NAME,
      });
    });

    it("rejects with NotFound when the booking has no session", async () => {
      const error = await captureError(deleteAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects with NotFound when the only session has no transcript", async () => {
      const session = await seedSessionWithoutTranscript({ status: "FAILED", outcomeReason: "NOT_ADMITTED" });

      const error = await captureError(deleteAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.sessions.get(session.id)?.resultsDeletedAt).toBeNull();
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects a second call with NotFound and keeps one DELETED row", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await deleteAs();

      const error = await captureError(deleteAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(actionsOf()).toEqual(["DELETED"]);
    });

    const liveStatuses: NotetakerSessionStatusDto[] = [
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
      "TRANSCRIBING",
      "PROCESSING",
    ];

    it.each(
      liveStatuses
    )("refuses with BadRequest while a session is %s and deletes nothing", async (status) => {
      const older = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        passages: buildPassages(2, 0, "older"),
      });
      await seedSummary(older.transcript.id, "OLDEROVERVIEW");
      const live = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        status,
        completeness: "PARTIAL",
        passages: buildPassages(1, 0, "live"),
      });
      await grantAttendee();
      const before = snapshotWrites();

      const error = await captureError(deleteAs());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(snapshotWrites()).toEqual(before);
      expect(repositories.store.transcripts.has(older.transcript.id)).toBe(true);
      expect(repositories.store.transcripts.has(live.transcript.id)).toBe(true);
      expect(repositories.store.passages.get(older.transcript.id)?.size).toBe(2);
      expect(repositories.store.sharingGrants.has(BOOKING_ID)).toBe(true);
    });

    it("refuses while a later session without a transcript is live", async () => {
      const older = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        passages: buildPassages(2),
      });
      await seedSessionWithoutTranscript({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        status: "WAITING_TO_BE_ADMITTED",
      });

      const error = await captureError(deleteAs());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(repositories.store.transcripts.has(older.transcript.id)).toBe(true);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("removes every transcript, passage and summary, stamps the sessions and drops the grant", async () => {
      const older = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        status: "ENDED_EARLY",
        outcomeReason: "STOPPED_BY_HOST",
        completeness: "PARTIAL",
        passages: buildPassages(3, 0, "older"),
      });
      const newer = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        passages: buildPassages(2, 0, "newer"),
      });
      await seedSummary(older.transcript.id, "OLDEROVERVIEW");
      await seedSummary(newer.transcript.id, "NEWEROVERVIEW");
      await grantAttendee();
      vi.setSystemTime(DELETED_AT);

      await expect(deleteAs()).resolves.toBeUndefined();

      const { store } = repositories;
      expect(store.transcripts.size).toBe(0);
      expect(store.passages.size).toBe(0);
      expect(store.summaries.size).toBe(0);
      expect(store.sessions.size).toBe(2);
      expect(store.sessions.get(older.session.id)).toMatchObject({
        status: "ENDED_EARLY",
        outcomeReason: "STOPPED_BY_HOST",
        resultsDeletedAt: DELETED_AT,
      });
      expect(store.sessions.get(newer.session.id)).toMatchObject({
        status: "READY",
        outcomeReason: null,
        resultsDeletedAt: DELETED_AT,
      });
      expect(store.sharingGrants.has(BOOKING_ID)).toBe(false);
      // The grant goes without a SHARING_REVOKED row: DELETED covers it.
      expect(actionsOf()).toEqual(["DELETED"]);
      expect(activitiesOf()[0]).toMatchObject({
        bookingId: BOOKING_ID,
        sessionId: null,
        action: "DELETED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: ORGANIZER_NAME,
        detail: null,
        createdAt: DELETED_AT,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
      const logged = loggedText();
      expect(logged).not.toContain("older 0");
      expect(logged).not.toContain("OLDEROVERVIEW");
    });

    it("stamps a later failed session that has no transcript as well", async () => {
      const early = await seedSessionWithoutTranscript({
        dispatchedAt: new Date("2026-10-12T08:30:00.000Z"),
        status: "FAILED",
        outcomeReason: "NOT_ADMITTED",
      });
      const withTranscript = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        passages: buildPassages(2),
      });
      const latest = await seedSessionWithoutTranscript({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
      });
      vi.setSystemTime(DELETED_AT);

      await deleteAs();

      const { store } = repositories;
      expect(store.transcripts.size).toBe(0);
      expect(store.sessions.get(withTranscript.session.id)?.resultsDeletedAt).toEqual(DELETED_AT);
      expect(store.sessions.get(latest.id)).toMatchObject({
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        resultsDeletedAt: DELETED_AT,
      });
      // Neither the latest session nor one that held a transcript.
      expect(store.sessions.get(early.id)?.resultsDeletedAt).toBeNull();
      expect(actionsOf()).toEqual(["DELETED"]);
    });

    it("writes one DELETED row and rejects the other call when two hosts delete at the same time", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      const seeded = await seedFinishedSession({ passages: buildPassages(2) });

      const results = await Promise.allSettled([deleteAs(ORGANIZER_ID), deleteAs(CO_HOST_ID)]);

      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ErrorWithCode);
      expect(rejected[0].reason).toMatchObject({ code: ErrorCode.NotFound });
      expect(actionsOf()).toEqual(["DELETED"]);
      expect(repositories.store.transcripts.size).toBe(0);
      expect(repositories.store.sessions.get(seeded.session.id)?.resultsDeletedAt).not.toBeNull();
    });

    it("leaves nothing readable, exportable or shareable afterwards", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();
      await deleteAs();
      const before = snapshotWrites();

      const hostList = await captureError(
        service.listPassages({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID })
      );
      const hostExport = await captureError(
        service.export({ bookingUid: BOOKING_UID, format: "markdown", userId: ORGANIZER_ID })
      );
      const attendeeList = await captureError(
        service.listPassages({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID })
      );
      const attendeeExport = await captureError(
        service.export({ bookingUid: BOOKING_UID, format: "markdown", userId: ATTENDEE_USER_ID })
      );
      const shareAgain = await captureError(
        service.setSharing({ bookingUid: BOOKING_UID, shared: true, userId: ORGANIZER_ID })
      );

      expect(hostList.code).toBe(ErrorCode.NotFound);
      expect(hostExport.code).toBe(ErrorCode.NotFound);
      // The grant went with the results, so the former attendee is a stranger again.
      expect(attendeeList.code).toBe(ErrorCode.Forbidden);
      expect(attendeeExport.code).toBe(ErrorCode.Forbidden);
      expect(shareAgain.code).toBe(ErrorCode.BadRequest);
      expect(snapshotWrites()).toEqual(before);
      expect(actionsOf()).toEqual(["DELETED"]);
    });

    it("does not touch another booking's transcript, passages, summary, session or grant", async () => {
      const { store } = repositories;
      store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: OTHER_BOOKING_UID }));
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();
      const other = await seedFinishedSession({
        bookingId: OTHER_BOOKING_ID,
        passages: buildPassages(3, 0, OTHER_PASSAGE_SENTINEL),
      });
      await seedSummary(other.transcript.id, OTHER_OVERVIEW_SENTINEL);
      await repositories.bookingNotetakerRepository.createSharingGrant({
        bookingId: OTHER_BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
      });

      await deleteAs();

      expect(Array.from(store.transcripts.keys())).toEqual([other.transcript.id]);
      expect(store.passages.get(other.transcript.id)?.size).toBe(3);
      expect(store.summaries.get(other.transcript.id)?.overview).toBe(OTHER_OVERVIEW_SENTINEL);
      expect(store.sessions.get(other.session.id)?.resultsDeletedAt).toBeNull();
      expect(store.sharingGrants.has(OTHER_BOOKING_ID)).toBe(true);
      expect(store.sharingGrants.has(BOOKING_ID)).toBe(false);
      expect(actionsOf(OTHER_BOOKING_ID)).toEqual([]);
      const otherList = await service.listPassages({ bookingUid: OTHER_BOOKING_UID, userId: ORGANIZER_ID });
      expect(otherList.passages).toHaveLength(3);
    });
  });

  describe("export", () => {
    function exportAs(
      userId: number = ORGANIZER_ID,
      bookingUid: string = BOOKING_UID
    ): Promise<NotetakerExportDto> {
      return service.export({ bookingUid, format: "markdown", userId });
    }

    it("gives the host the file and records one EXPORTED row for the session", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(2) });

      const result = await exportAs();

      expect(Object.keys(result).sort()).toEqual(["content", "filename", "mimeType"]);
      expect(result.mimeType).toBe("text/markdown");
      expect(result.filename).toMatch(EXPORT_FILENAME_PATTERN);
      expect(result.filename).toBe("planning-call-2026-10-12.md");
      expect(result.content).toContain("# Planning call");
      expect(result.content).toContain("## notetaker_export_summary_heading");
      expect(result.content).toContain("## notetaker_export_transcript_heading");
      expect(result.content).toContain("Ada");
      expect(result.content).toContain("passage 0");
      expect(result.content).toContain("passage 1");
      expect(activitiesOf()).toHaveLength(1);
      expect(activitiesOf()[0]).toMatchObject({
        bookingId: BOOKING_ID,
        sessionId: seeded.session.id,
        action: "EXPORTED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: ORGANIZER_NAME,
        detail: null,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
      const logged = loggedText();
      expect(logged).not.toContain("passage");
      expect(logged).not.toContain("Planning call");
    });

    it("adds the speaker names sentence only when the transcript says names were unavailable", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(1) });

      expect((await exportAs()).content).not.toContain("notetaker_speaker_names_unavailable");

      await repositories.transcriptRepository.update(seeded.transcript.id, { speakerNamesAvailable: false });

      expect((await exportAs()).content).toContain("> notetaker_speaker_names_unavailable");
    });

    it("records one EXPORTED row for every call", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });

      const first = await exportAs();
      const second = await exportAs();

      expect(second).toEqual(first);
      expect(actionsOf()).toEqual(["EXPORTED", "EXPORTED"]);
    });

    it("gives a granted attendee the same file and records them as the actor", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();

      const asHost = await exportAs(ORGANIZER_ID);
      const asAttendee = await exportAs(ATTENDEE_USER_ID);

      expect(asAttendee).toEqual(asHost);
      expect(asAttendee.content).toContain("passage 0");
      expect(actionsOf()).toEqual(["EXPORTED", "EXPORTED"]);
      expect(activitiesOf()[1]).toMatchObject({
        sessionId: seeded.session.id,
        action: "EXPORTED",
        actorType: "USER",
        actorUserId: ATTENDEE_USER_ID,
        actorName: ATTENDEE_NAME,
        detail: null,
      });
    });

    it("lets an event-type co-host who is an attendee export without a grant", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(1) });

      const result = await exportAs(CO_HOST_ID);

      expect(result.content).toContain("passage 0");
      expect(activitiesOf()[0]).toMatchObject({ action: "EXPORTED", actorUserId: CO_HOST_ID });
    });

    it("refuses an attendee without a grant and writes nothing", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      const error = await captureError(exportAs(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("refuses a user whose verified email is not an attendee address although a grant exists", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, ["someone.else@example.com"]);

      const error = await captureError(exportAs(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("refuses an unrelated user and writes nothing", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });
      await grantAttendee();

      const error = await captureError(exportAs(STRANGER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("refuses an unrelated user with Forbidden when the booking has no transcript", async () => {
      const error = await captureError(exportAs(STRANGER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects an unknown booking uid for a host and for an unrelated user alike", async () => {
      await seedFinishedSession({ passages: buildPassages(2) });

      const asHost = await captureError(exportAs(ORGANIZER_ID, "missing-uid"));
      const asStranger = await captureError(exportAs(STRANGER_ID, "missing-uid"));

      expect(asHost.code).toBe(ErrorCode.NotFound);
      expect(asStranger.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects with NotFound when the booking has no session", async () => {
      const error = await captureError(exportAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects with NotFound when the only session has no transcript", async () => {
      await seedSessionWithoutTranscript({ status: "FAILED", outcomeReason: "NOT_ADMITTED" });

      const error = await captureError(exportAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("rejects with NotFound once the results were deleted", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(2) });
      await repositories.sessionRepository.setResultsDeletedAtByIds([seeded.session.id], DELETED_AT);

      const error = await captureError(exportAs());

      expect(error.code).toBe(ErrorCode.NotFound);
      expect(repositories.store.activities).toHaveLength(0);
    });

    it("exports only the newer of two sessions that both have a transcript", async () => {
      await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        passages: buildPassages(2, 0, "older"),
      });
      const newer = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        passages: buildPassages(2, 0, "newer"),
      });

      const result = await exportAs();

      expect(result.content).toContain("newer 0");
      expect(result.content).toContain("newer 1");
      expect(result.content).not.toContain("older");
      expect(activitiesOf()[0].sessionId).toBe(newer.session.id);
    });

    it("exports the latest session that has a transcript when a later one has none", async () => {
      const older = await seedFinishedSession({
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
        passages: buildPassages(1, 0, "older"),
      });
      await seedSessionWithoutTranscript({
        dispatchedAt: new Date("2026-10-12T09:30:00.000Z"),
        status: "FAILED",
        outcomeReason: "NOT_ADMITTED",
      });

      const result = await exportAs();

      expect(result.content).toContain("older 0");
      expect(activitiesOf()[0].sessionId).toBe(older.session.id);
    });

    it("never includes another booking's passages or summary", async () => {
      repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: OTHER_BOOKING_UID }));
      await seedFinishedSession({ passages: buildPassages(2) });
      // Dispatched later than this booking's session: a lookup that forgot the booking would pick it.
      const other = await seedFinishedSession({
        bookingId: OTHER_BOOKING_ID,
        dispatchedAt: new Date("2026-10-12T10:30:00.000Z"),
        passages: buildPassages(2, 0, OTHER_PASSAGE_SENTINEL),
      });
      await seedSummary(other.transcript.id, OTHER_OVERVIEW_SENTINEL);

      const result = await exportAs();

      expect(result.content).toContain("passage 0");
      expect(result.content).not.toContain(OTHER_PASSAGE_SENTINEL);
      expect(result.content).not.toContain(OTHER_OVERVIEW_SENTINEL);
      expect(actionsOf(OTHER_BOOKING_ID)).toEqual([]);
    });

    it("holds no speaker key, no email address, no booking uid and no meeting link", async () => {
      repositories.store.addBooking(buildBooking({ uid: BOOKING_UID_SENTINEL }));
      const passages = buildPassages(3).map((passage) => ({ ...passage, speakerKey: SPEAKER_KEY_SENTINEL }));
      passages[2] = { ...passages[2], speakerName: null, unknownSpeakerNumber: 1 };
      const seeded = await seedFinishedSession({ passages });
      await seedSummary(seeded.transcript.id, "READYOVERVIEW");
      await grantAttendee();

      const asHost = await exportAs(ORGANIZER_ID, BOOKING_UID_SENTINEL);
      const asAttendee = await exportAs(ATTENDEE_USER_ID, BOOKING_UID_SENTINEL);

      for (const result of [asHost, asAttendee]) {
        expect(result.content).toContain("passage 2");
        expect(result.content).toContain("notetaker");
        expect(result.content).not.toContain(SPEAKER_KEY_SENTINEL);
        expect(result.content).not.toContain(BOOKING_UID_SENTINEL);
        expect(result.content).not.toContain("@");
        expect(result.content).not.toContain("example");
        expect(result.content).not.toContain("google");
        expect(result.filename).toMatch(EXPORT_FILENAME_PATTERN);
        expect(result.filename.toUpperCase()).not.toContain(BOOKING_UID_SENTINEL);
      }
    });

    it("includes a READY summary", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(1) });
      await seedSummary(seeded.transcript.id, "READYOVERVIEW");

      const result = await exportAs();

      expect(result.content).toContain("### notetaker_summary_overview");
      expect(result.content).toContain("### notetaker_summary_key_points");
      expect(result.content).toContain("### notetaker_summary_decisions");
      expect(result.content).toContain("### notetaker_summary_action_items");
      expect(result.content).toContain("READYOVERVIEW");
      expect(result.content).toContain("READYOVERVIEWKEYPOINT");
      expect(result.content).toContain("READYOVERVIEWDECISION");
      expect(result.content).toContain("READYOVERVIEWACTIONITEM");
      expect(result.content).not.toContain("notetaker_export_no_summary");
    });

    const notReadyStatuses: NotetakerSummaryStatusDto[] = ["PENDING", "FAILED", "NOT_ENOUGH_CONTENT"];

    it.each(
      notReadyStatuses
    )("gives the no-summary line and no summary text for a %s summary", async (status) => {
      const seeded = await seedFinishedSession({ passages: buildPassages(1) });
      await seedSummary(seeded.transcript.id, "STALEOVERVIEW", status);

      const result = await exportAs();

      expect(result.content).toContain("notetaker_export_no_summary");
      expect(result.content).not.toContain("STALEOVERVIEW");
      expect(result.content).toContain("passage 0");
    });

    it("gives the no-summary line when there is no summary row", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });

      const result = await exportAs();

      expect(result.content).toContain("notetaker_export_no_summary");
    });

    it("carries the incomplete note with the reason key for a PARTIAL transcript", async () => {
      await seedFinishedSession({
        status: "ENDED_EARLY",
        outcomeReason: "STOPPED_BY_HOST",
        completeness: "PARTIAL",
        passages: buildPassages(1),
      });

      const result = await exportAs();

      expect(result.content).toContain("notetaker_transcript_incomplete");
      expect(result.content).toContain("notetaker_reason_stopped_by_host");
      expect(result.content).not.toContain("notetaker_transcript_truncated");
    });

    it("falls back to the interrupted reason when a PARTIAL transcript has no outcome reason", async () => {
      await seedFinishedSession({ completeness: "PARTIAL", passages: buildPassages(1) });

      const result = await exportAs();

      expect(result.content).toContain("notetaker_transcript_incomplete");
      expect(result.content).toContain("notetaker_reason_interrupted");
    });

    it("carries the truncated note for a TRUNCATED transcript", async () => {
      await seedFinishedSession({
        outcomeReason: "LENGTH_LIMIT_REACHED",
        completeness: "TRUNCATED",
        passages: buildPassages(1),
      });

      const result = await exportAs();

      expect(result.content).toContain("notetaker_transcript_truncated");
      expect(result.content).not.toContain("notetaker_transcript_incomplete");
    });

    it("carries no note for a COMPLETE transcript", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });

      const result = await exportAs();

      expect(result.content).not.toContain("notetaker_transcript_incomplete");
      expect(result.content).not.toContain("notetaker_transcript_truncated");
    });

    it("requests the translator in the caller's locale", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await seedFinishedSession({ passages: buildPassages(1) });

      await exportAs(CO_HOST_ID);

      expect(getTranslation).toHaveBeenCalledTimes(1);
      expect(getTranslation).toHaveBeenCalledWith("de", "common");
    });

    it("falls back to en when the caller has no locale", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });
      await grantAttendee();

      await exportAs(ATTENDEE_USER_ID);

      expect(getTranslation).toHaveBeenCalledTimes(1);
      expect(getTranslation).toHaveBeenCalledWith("en", "common");
    });

    it("falls back to en, UTC and a null actor name when the user lookup does not return the caller", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });
      users = [];

      const result = await exportAs();

      expect(getTranslation).toHaveBeenCalledTimes(1);
      expect(getTranslation).toHaveBeenCalledWith("en", "common");
      expect(result.filename).toBe("planning-call-2026-10-12.md");
      expect(activitiesOf()[0]).toMatchObject({
        action: "EXPORTED",
        actorUserId: ORGANIZER_ID,
        actorName: null,
      });
    });

    it("dates the file in the caller's time zone", async () => {
      repositories.store.addBooking(
        buildCoHostBooking({
          startTime: new Date("2026-10-12T22:30:00.000Z"),
          endTime: new Date("2026-10-12T23:00:00.000Z"),
        })
      );
      await seedFinishedSession({ passages: buildPassages(1) });

      const inUtc = await exportAs(ORGANIZER_ID);
      const inBerlin = await exportAs(CO_HOST_ID);

      expect(inUtc.filename).toBe("planning-call-2026-10-12.md");
      expect(inBerlin.filename).toBe("planning-call-2026-10-13.md");
    });

    it("rejects when the EXPORTED activity cannot be written", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });
      vi.spyOn(repositories.activityRepository, "create").mockRejectedValueOnce(
        new Error("activity write failed")
      );

      await expect(exportAs()).rejects.toThrow("activity write failed");

      expect(repositories.store.activities).toHaveLength(0);
    });
  });

  describe("getActivity", () => {
    function getActivityAs(userId: number = ORGANIZER_ID): Promise<NotetakerActivityDto[]> {
      return service.getActivity({ bookingUid: BOOKING_UID, userId });
    }

    describe("access", () => {
      itRefusesEveryoneButAHost((params) => service.getActivity(params));
    });

    it("lets an event-type co-host who is an attendee read the activity", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      const created = await recordActivity();

      const result = await getActivityAs(CO_HOST_ID);

      expect(result.map((activity) => activity.id)).toEqual([created.id]);
    });

    it("returns an empty list for a booking without activity or transcript", async () => {
      await expect(getActivityAs()).resolves.toEqual([]);
    });

    it("returns rows of all three actor types newest first, breaking ties by id descending", async () => {
      const byUser = await recordActivity({ action: "ENABLED" });
      vi.setSystemTime(new Date(NOW.getTime() + 1000));
      const byParticipant = await recordActivity({
        action: "STOPPED",
        actorType: "PARTICIPANT",
        actorUserId: null,
        actorName: "Guest",
      });
      vi.setSystemTime(new Date(NOW.getTime() + 2000));
      const bySystem = await recordActivity({
        action: "DISABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
      });
      const sameMillisecond = await recordActivity({ action: "SUMMARY_REQUESTED" });

      const result = await getActivityAs();

      expect(sameMillisecond.createdAt).toEqual(bySystem.createdAt);
      expect(result.map((activity) => activity.id)).toEqual([
        sameMillisecond.id,
        bySystem.id,
        byParticipant.id,
        byUser.id,
      ]);
      expect(result.map((activity) => activity.actorType)).toEqual(["USER", "SYSTEM", "PARTICIPANT", "USER"]);
      expect(result.map((activity) => activity.actorName)).toEqual([
        ORGANIZER_NAME,
        null,
        "Guest",
        ORGANIZER_NAME,
      ]);
    });

    it("returns the newest 200 of 205 rows", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 205; i += 1) {
        // Five rows share each second, so the cut-off also depends on the id tie-break.
        vi.setSystemTime(new Date(NOW.getTime() + Math.floor(i / 5) * 1000));
        const created = await recordActivity();
        ids.push(created.id);
      }

      const result = await getActivityAs();

      expect(NOTETAKER_ACTIVITY_LIMIT).toBe(200);
      expect(result).toHaveLength(200);
      expect(result.map((activity) => activity.id)).toEqual(ids.slice(5).reverse());
    });

    it("maps a row to exactly the six DTO fields with an ISO createdAt", async () => {
      const seeded = await seedFinishedSession({ passages: buildPassages(1) });
      const created = await recordActivity({
        sessionId: seeded.session.id,
        action: "STOPPED",
        detail: { reason: "STOPPED_BY_HOST" },
      });

      const result = await getActivityAs();

      expect(result).toHaveLength(1);
      expect(Object.keys(result[0]).sort()).toEqual([
        "action",
        "actorName",
        "actorType",
        "createdAt",
        "detail",
        "id",
      ]);
      expect(result[0]).toEqual({
        id: created.id,
        action: "STOPPED",
        actorType: "USER",
        actorName: ORGANIZER_NAME,
        createdAt: "2026-10-12T11:00:00.000Z",
        detail: { reason: "STOPPED_BY_HOST" },
      });
      expect(new Date(result[0].createdAt).toISOString()).toBe(result[0].createdAt);
    });

    it("does not return another booking's rows", async () => {
      repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: OTHER_BOOKING_UID }));
      const own = await recordActivity();
      await recordActivity({ bookingId: OTHER_BOOKING_ID, action: "DELETED" });

      const result = await getActivityAs();

      expect(result.map((activity) => activity.id)).toEqual([own.id]);
    });

    it("lists what the other methods recorded, without writing a row itself", async () => {
      await seedFinishedSession({ passages: buildPassages(1) });
      await service.setSharing({ bookingUid: BOOKING_UID, shared: true, userId: ORGANIZER_ID });
      vi.setSystemTime(new Date(NOW.getTime() + 1000));
      await service.export({ bookingUid: BOOKING_UID, format: "markdown", userId: ORGANIZER_ID });
      vi.setSystemTime(new Date(NOW.getTime() + 2000));
      await service.deleteResults({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      const result = await getActivityAs();

      expect(result.map((activity) => activity.action)).toEqual(["DELETED", "EXPORTED", "SHARED"]);
      expect(repositories.store.activities).toHaveLength(3);
    });
  });
});
