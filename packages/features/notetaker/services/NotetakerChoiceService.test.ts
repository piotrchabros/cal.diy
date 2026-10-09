import { DailyLocationType, MeetLocationType } from "@calcom/app-store/constants";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type {
  NotetakerIneligibilityReasonDto,
  NotetakerSessionStatusDto,
} from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TriggerOptions } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerConfig } from "../lib/config";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import type { InMemoryBookingSeed, InMemoryEventTypeSeed } from "../tests/InMemoryNotetakerRepositories";
import {
  createInMemoryNotetakerRepositories,
  InMemoryBookingNotetakerRepository,
} from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { NotetakerChoiceService } from "./NotetakerChoiceService";

const NOW = new Date("2026-10-12T09:00:00.000Z");
const AFTER_END = new Date("2026-10-12T10:31:00.000Z");
const AT_END = new Date("2026-10-12T10:30:00.000Z");

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;
const CO_HOST_ID = 2;
const ATTENDEE_USER_ID = 3;
const STRANGER_ID = 5;

const ORGANIZER_EMAIL = "organizer@example.com";
const CO_HOST_EMAIL = "cohost@example.com";
const ATTENDEE_EMAIL = "attendee@example.com";

const MEET_LINK = "https://meet.google.com/abc-defg-hij";

const EVENT_TYPE_ID = 10;
const SERIES_ID = "rec-1";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_BOOKING_ID = 200;
const NEW_BOOKING_UID = "booking-uid-new";
const OLD_SET_AT = new Date("2026-10-10T08:00:00.000Z");

function buildBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: BOOKING_ID,
    uid: BOOKING_UID,
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime: new Date("2026-10-12T10:00:00.000Z"),
    endTime: new Date("2026-10-12T10:30:00.000Z"),
    title: "Planning call",
    location: MEET_LINK,
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

function buildConfig(overrides: Partial<NotetakerConfig> = {}): NotetakerConfig {
  return {
    limits: {
      admissionTimeoutSeconds: 600,
      noShowTimeoutSeconds: 900,
      aloneTimeoutSeconds: 120,
      maxDurationSeconds: 14400,
      joinLeadSeconds: 120,
      heartbeatTimeoutSeconds: 180,
      summaryMinWords: 40,
    },
    enabledPlatforms: ["GOOGLE_MEET"],
    botProvider: "FAKE",
    botUrl: null,
    botSecret: null,
    summaryModel: "test-model",
    anthropicApiKey: null,
    fakeScenario: "happy",
    ...overrides,
  };
}

function buildCoHostBooking(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return buildBooking({
    attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
    eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
    ...overrides,
  });
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
    this.sendNotificationCalls.push({ payload, options });
    return { runId: this.sendNotificationRunId };
  }
}

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } satisfies ISimpleLogger;
}

// Models a second host blocking the booking after this request passed the eligibility check.
class BlockingBeforeEnableRepository extends InMemoryBookingNotetakerRepository {
  async enableIfDisabled(
    data: Parameters<IBookingNotetakerRepository["enableIfDisabled"]>[0]
  ): Promise<boolean> {
    await this.setRejoinBlocked(data.bookingId, true);
    return super.enableIfDisabled(data);
  }
}

describe("NotetakerChoiceService", () => {
  const checkIfUserHasFeature = vi.fn(async (_userId: number, _slug: string): Promise<boolean> => true);
  let users: NotetakerUserRecord[];
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let tasker: RecordingNotetakerTasker;
  let logger: ReturnType<typeof createLogger>;
  let service: NotetakerChoiceService;

  function buildService(
    config: NotetakerConfig = buildConfig(),
    bookingNotetakerRepository: IBookingNotetakerRepository = repositories.bookingNotetakerRepository
  ): NotetakerChoiceService {
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
    };
    return new NotetakerChoiceService({
      bookingNotetakerRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      activityRepository: repositories.activityRepository,
      accessService: new NotetakerAccessService({ bookingNotetakerRepository }),
      featuresRepository: { checkIfUserHasFeature },
      userRepository,
      notetakerTasker: tasker,
      logger,
      config,
    });
  }

  function userRecord(id: number, name: string): NotetakerUserRecord {
    return { id, name, email: `user${id}@example.com`, locale: "en", timeZone: "UTC" };
  }

  function createSession(status: NotetakerSessionStatusDto): Promise<NotetakerSessionRecord> {
    return repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: MEET_LINK,
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      status,
    });
  }

  function enable(userId: number = ORGANIZER_ID): Promise<void> {
    return service.setEnabled({
      bookingUid: BOOKING_UID,
      enabled: true,
      scope: "THIS_BOOKING",
      userId,
    });
  }

  function disable(userId: number = ORGANIZER_ID): Promise<void> {
    return service.setEnabled({
      bookingUid: BOOKING_UID,
      enabled: false,
      scope: "THIS_BOOKING",
      userId,
    });
  }

  function getState(userId: number = ORGANIZER_ID) {
    return service.getState({ bookingUid: BOOKING_UID, userId });
  }

  async function blockEnabledChoice(): Promise<void> {
    await enable();
    await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);
  }

  async function blockDisabledChoice(): Promise<void> {
    await enable();
    await disable();
    await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);
  }

  function expectRejoinBlocked(error: ErrorWithCode): void {
    expect(error.code).toBe(ErrorCode.BadRequest);
    expect(error.message).toBe("REJOIN_BLOCKED");
    expect(error.data).toEqual({ reason: "REJOIN_BLOCKED" });
  }

  function expectNothingWritten(): void {
    expect(repositories.store.choices.size).toBe(0);
    expect(repositories.store.activities).toHaveLength(0);
    expect(tasker.sendNotificationCalls).toHaveLength(0);
  }

  function seedEventType(overrides: Partial<InMemoryEventTypeSeed> = {}): void {
    repositories.store.addEventType({
      id: EVENT_TYPE_ID,
      userId: ORGANIZER_ID,
      teamId: null,
      locations: [{ type: MeetLocationType }],
      ownerName: "Organizer",
      ...overrides,
    });
  }

  async function seedDefaultOn(overrides: Partial<InMemoryEventTypeSeed> = {}): Promise<void> {
    seedEventType(overrides);
    await repositories.eventTypeNotetakerSettingsRepository.upsert({
      eventTypeId: EVENT_TYPE_ID,
      enabledByDefault: true,
    });
  }

  function seedSeries(
    count: number,
    overridesByIndex: Record<number, Partial<InMemoryBookingSeed>> = {}
  ): void {
    const base = buildBooking();
    for (let k = 0; k < count; k += 1) {
      repositories.store.addBooking(
        buildBooking({
          id: BOOKING_ID + k,
          uid: k === 0 ? BOOKING_UID : `series-uid-${k}`,
          recurringEventId: SERIES_ID,
          startTime: new Date(base.startTime.getTime() + k * WEEK_MS),
          endTime: new Date(base.endTime.getTime() + k * WEEK_MS),
          ...overridesByIndex[k],
        })
      );
    }
  }

  function setScope(
    enabled: boolean,
    bookingUid: string = BOOKING_UID,
    userId: number = ORGANIZER_ID
  ): Promise<void> {
    return service.setEnabled({ bookingUid, enabled, scope: "ALL_FUTURE_OCCURRENCES", userId });
  }

  function snapshot() {
    return structuredClone({
      choices: Array.from(repositories.store.choices.values()),
      settings: Array.from(repositories.store.eventTypeSettings.values()),
      activities: [...repositories.store.activities],
      notices: [...tasker.sendNotificationCalls],
    });
  }

  function noticeFor(bookingId: number) {
    return {
      payload: { kind: "ATTENDEE_NOTICE", bookingId, sessionId: null },
      options: undefined,
    };
  }

  function activitiesFor(bookingId: number) {
    return repositories.store.activities.filter((activity) => activity.bookingId === bookingId);
  }

  function resetServices(): void {
    repositories = createInMemoryNotetakerRepositories();
    tasker = new RecordingNotetakerTasker();
    logger = createLogger();
    service = buildService();
  }

  function seedOldChoice(
    overrides: Partial<Parameters<IBookingNotetakerRepository["upsert"]>[0]> = {}
  ): Promise<unknown> {
    return repositories.bookingNotetakerRepository.upsert({
      bookingId: BOOKING_ID,
      enabled: true,
      pendingDispatch: false,
      source: "HOST",
      appliedToSeries: true,
      setByUserId: CO_HOST_ID,
      setAt: OLD_SET_AT,
      notifiedAttendeeEmails: [ATTENDEE_EMAIL],
      ...overrides,
    });
  }

  function seedRescheduledPair(): void {
    repositories.store.addBooking(buildBooking({ status: "CANCELLED" }));
    repositories.store.addBooking(
      buildBooking({
        id: NEW_BOOKING_ID,
        uid: NEW_BOOKING_UID,
        startTime: new Date("2026-10-13T10:00:00.000Z"),
        endTime: new Date("2026-10-13T10:30:00.000Z"),
      })
    );
  }

  function reschedule(): Promise<void> {
    return service.onBookingRescheduled({ bookingUid: NEW_BOOKING_UID, oldBookingUid: BOOKING_UID });
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    checkIfUserHasFeature.mockReset();
    checkIfUserHasFeature.mockResolvedValue(true);
    users = [userRecord(ORGANIZER_ID, "Organizer"), userRecord(CO_HOST_ID, "Co Host")];
    repositories = createInMemoryNotetakerRepositories();
    tasker = new RecordingNotetakerTasker();
    logger = createLogger();
    service = buildService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("setEnabled", () => {
    it("rejects a non-host with Forbidden and writes nothing", async () => {
      repositories.store.addBooking(buildBooking());

      const error = await captureError(enable(STRANGER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expectNothingWritten();
    });

    it("rejects a granted attendee with Forbidden", async () => {
      repositories.store.addBooking(buildBooking());
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await repositories.bookingNotetakerRepository.createSharingGrant({
        bookingId: BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
      });

      const error = await captureError(enable(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
      expectNothingWritten();
    });

    it("rejects an unknown booking with NotFound", async () => {
      const error = await captureError(enable());

      expect(error.code).toBe(ErrorCode.NotFound);
    });

    it("refuses with FEATURE_DISABLED when the notetaker flag is off for the host", async () => {
      repositories.store.addBooking(buildBooking());
      checkIfUserHasFeature.mockResolvedValue(false);

      const error = await captureError(enable());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe("FEATURE_DISABLED");
      expect(error.data).toEqual({ reason: "FEATURE_DISABLED" });
      expect(checkIfUserHasFeature).toHaveBeenCalledWith(ORGANIZER_ID, "notetaker");
      expectNothingWritten();
    });

    it("refuses with FEATURE_DISABLED when the bot provider is unusable", async () => {
      repositories.store.addBooking(buildBooking());
      service = buildService(buildConfig({ botProvider: null }));

      const error = await captureError(enable());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe("FEATURE_DISABLED");
      expect(error.data).toEqual({ reason: "FEATURE_DISABLED" });
      expectNothingWritten();
    });

    it.each<{
      name: string;
      overrides: Partial<InMemoryBookingSeed>;
      reason: NotetakerIneligibilityReasonDto;
    }>([
      {
        name: "an unsupported platform",
        overrides: { location: "https://zoom.us/j/123" },
        reason: "UNSUPPORTED_PLATFORM",
      },
      { name: "Cal Video", overrides: { location: DailyLocationType }, reason: "CAL_VIDEO" },
      {
        name: "an in-person location",
        overrides: { location: "123 Main Street" },
        reason: "IN_PERSON_OR_PHONE",
      },
      { name: "a cancelled booking", overrides: { status: "CANCELLED" }, reason: "BOOKING_NOT_ACTIVE" },
      { name: "a rejected booking", overrides: { status: "REJECTED" }, reason: "BOOKING_NOT_ACTIVE" },
    ])("refuses with $reason for $name", async ({ overrides, reason }) => {
      repositories.store.addBooking(buildBooking(overrides));

      const error = await captureError(enable());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe(reason);
      expect(error.data).toEqual({ reason });
      expectNothingWritten();
    });

    it("enables a Google Meet booking whose link is not stored yet", async () => {
      repositories.store.addBooking(
        buildBooking({ location: MeetLocationType, status: "ACCEPTED", metadata: null, references: [] })
      );

      await expect(enable()).resolves.toBeUndefined();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
        source: "HOST",
      });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual(["ENABLED"]);
    });

    it("refuses with MEETING_ENDED after the booking end time", async () => {
      repositories.store.addBooking(buildBooking());
      vi.setSystemTime(AFTER_END);

      const error = await captureError(enable());

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe("MEETING_ENDED");
      expect(error.data).toEqual({ reason: "MEETING_ENDED" });
      expectNothingWritten();
    });

    it("refuses with MEETING_ENDED exactly at the booking end time", async () => {
      repositories.store.addBooking(buildBooking());
      vi.setSystemTime(AT_END);

      const error = await captureError(enable());

      expect(error.message).toBe("MEETING_ENDED");
      expectNothingWritten();
    });

    it("arms an off-to-on choice and records one ENABLED activity", async () => {
      repositories.store.addBooking(buildBooking());

      await enable();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        bookingId: BOOKING_ID,
        enabled: true,
        pendingDispatch: true,
        source: "HOST",
        appliedToSeries: false,
        setByUserId: ORGANIZER_ID,
        setAt: NOW,
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId: BOOKING_ID,
        action: "ENABLED",
        actorType: "USER",
        actorUserId: ORGANIZER_ID,
        actorName: "Organizer",
        sessionId: null,
        detail: null,
      });
      expect(tasker.sendNotificationCalls).toEqual([
        { payload: { kind: "ATTENDEE_NOTICE", bookingId: BOOKING_ID, sessionId: null }, options: undefined },
      ]);
      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        rejoinBlocked: false,
        attendeesNotifiedAt: null,
        notifiedAttendeeEmails: [],
      });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("does not arm a second time when another host enables an already enabled booking", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await enable(ORGANIZER_ID);
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);

      await enable(CO_HOST_ID);

      const choice = repositories.store.choices.get(BOOKING_ID);
      expect(choice?.pendingDispatch).toBe(false);
      expect(choice?.setByUserId).toBe(ORGANIZER_ID);
      expect(repositories.store.activities).toHaveLength(1);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("turns an enabled choice off, keeps notified attendee emails and records DISABLED", async () => {
      repositories.store.addBooking(buildCoHostBooking());
      await enable(ORGANIZER_ID);
      await repositories.bookingNotetakerRepository.appendNotifiedAttendeeEmails(
        BOOKING_ID,
        [ATTENDEE_EMAIL],
        NOW
      );

      await disable(CO_HOST_ID);

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
        notifiedAttendeeEmails: [ATTENDEE_EMAIL],
        setByUserId: CO_HOST_ID,
      });
      expect(repositories.store.activities).toHaveLength(2);
      expect(repositories.store.activities[1]).toMatchObject({
        action: "DISABLED",
        actorType: "USER",
        actorUserId: CO_HOST_ID,
        actorName: "Co Host",
        sessionId: null,
        detail: null,
      });
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("creates no row and no activity when disabling a booking that has no choice", async () => {
      repositories.store.addBooking(buildBooking());

      await expect(disable()).resolves.toBeUndefined();

      expectNothingWritten();
    });

    it("records nothing when disabling a choice that is already off", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();
      await disable();

      expect(repositories.store.activities).toHaveLength(2);
    });

    it("re-arms the dispatch when a disabled choice is enabled again", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);
      await repositories.bookingNotetakerRepository.appendNotifiedAttendeeEmails(
        BOOKING_ID,
        [ATTENDEE_EMAIL],
        NOW
      );
      await disable();

      await enable();

      expect(repositories.store.choices.get(BOOKING_ID)?.pendingDispatch).toBe(true);
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
        "ENABLED",
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(2);
      expect(repositories.store.choices.get(BOOKING_ID)?.notifiedAttendeeEmails).toEqual([ATTENDEE_EMAIL]);
    });

    it("allows disabling after the booking end time", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      vi.setSystemTime(AFTER_END);

      await disable();

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(false);
    });

    it("stores the choice for a PENDING booking", async () => {
      repositories.store.addBooking(buildBooking({ status: "PENDING" }));

      await enable();

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
    });

    it("snapshots a null actor name when the acting user is unknown to the lookup", async () => {
      repositories.store.addBooking(buildBooking());
      users = [];

      await enable();

      expect(repositories.store.activities[0].actorName).toBeNull();
    });

    it("refuses with REJOIN_BLOCKED when a disabled choice is rejoin-blocked", async () => {
      repositories.store.addBooking(buildBooking());
      await blockDisabledChoice();

      const error = await captureError(enable());

      expectRejoinBlocked(error);
      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
      });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("refuses with REJOIN_BLOCKED when the blocked choice is still enabled", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.setPendingDispatch(BOOKING_ID, false);
      await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);

      const error = await captureError(enable());

      expectRejoinBlocked(error);
      expect(repositories.store.choices.get(BOOKING_ID)?.pendingDispatch).toBe(false);
      expect(repositories.store.activities).toHaveLength(1);
    });

    it("reports REJOIN_BLOCKED before MEETING_ENDED", async () => {
      repositories.store.addBooking(buildBooking());
      await blockDisabledChoice();
      vi.setSystemTime(AFTER_END);

      const error = await captureError(enable());

      expect(error.message).toBe("REJOIN_BLOCKED");
    });

    it("reports BOOKING_NOT_ACTIVE before REJOIN_BLOCKED", async () => {
      repositories.store.addBooking(buildBooking());
      await blockDisabledChoice();
      repositories.store.addBooking(buildBooking({ status: "CANCELLED" }));

      const error = await captureError(enable());

      expect(error.message).toBe("BOOKING_NOT_ACTIVE");
    });

    it("reports FEATURE_DISABLED before REJOIN_BLOCKED", async () => {
      repositories.store.addBooking(buildBooking());
      await blockDisabledChoice();
      checkIfUserHasFeature.mockResolvedValue(false);

      const error = await captureError(enable());

      expect(error.message).toBe("FEATURE_DISABLED");
    });

    it("does not set rejoinBlocked when the host disables before admission", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();

      expect(repositories.store.choices.get(BOOKING_ID)?.rejoinBlocked).toBe(false);

      await expect(enable()).resolves.toBeUndefined();
      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
      });
    });

    it("keeps rejoinBlocked when a blocked choice is turned off", async () => {
      repositories.store.addBooking(buildBooking());
      await blockEnabledChoice();

      await expect(disable()).resolves.toBeUndefined();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        rejoinBlocked: true,
      });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("writes one ENABLED activity and one notice when two hosts enable at the same time", async () => {
      repositories.store.addBooking(buildCoHostBooking());

      await Promise.all([enable(ORGANIZER_ID), enable(CO_HOST_ID)]);

      const choice = repositories.store.choices.get(BOOKING_ID);
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0].action).toBe("ENABLED");
      expect(tasker.sendNotificationCalls).toHaveLength(1);
      expect(choice).toMatchObject({ enabled: true, pendingDispatch: true });
      expect(repositories.store.activities[0].actorUserId).toBe(choice?.setByUserId);
    });

    it("refuses with REJOIN_BLOCKED when the choice is blocked between the eligibility check and the write", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();
      service = buildService(buildConfig(), new BlockingBeforeEnableRepository(repositories.store));

      const error = await captureError(enable());

      expectRejoinBlocked(error);
      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
        rejoinBlocked: true,
      });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("logs a failed notice enqueue and keeps the choice enabled", async () => {
      repositories.store.addBooking(buildBooking());
      tasker.sendNotificationRunId = "task-failed";

      await expect(enable()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][1]).toEqual({ bookingId: BOOKING_ID });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(ATTENDEE_EMAIL);
      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
      });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual(["ENABLED"]);
    });
  });

  describe("getState", () => {
    it("reports an empty state for a booking without a choice", async () => {
      repositories.store.addBooking(buildBooking());

      const state = await getState();

      expect(state).toEqual({
        bookingUid: BOOKING_UID,
        featureEnabled: true,
        viewerRole: "HOST",
        eligibility: { eligible: true, platform: "GOOGLE_MEET", reason: null },
        choice: null,
        status: null,
        canToggle: true,
        canStop: false,
        isRecurring: false,
        session: null,
        transcript: null,
        summary: null,
        sharedWithAttendees: false,
      });
    });

    it("reports SCHEDULED for an enabled and pending choice", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();

      const state = await getState();

      expect(state.status).toBe("SCHEDULED");
      expect(state.choice).toEqual({
        enabled: true,
        source: "HOST",
        appliedToSeries: false,
        setByName: "Organizer",
        setAt: NOW.toISOString(),
      });
    });

    it("reports the latest session status once the dispatch was consumed", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);
      const session = await createSession("TRANSCRIBING");

      const state = await getState();

      expect(state.status).toBe("TRANSCRIBING");
      expect(state.session?.id).toBe(session.id);
      expect(state.session?.status).toBe("TRANSCRIBING");
      expect(state.canStop).toBe(true);
    });

    it("keeps a terminal session status after the host disables the choice", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);
      await createSession("READY");
      await disable();

      const state = await getState();

      expect(state.status).toBe("READY");
      expect(state.canStop).toBe(false);
    });

    it("reports SCHEDULED again when a terminal session is followed by a re-armed choice", async () => {
      repositories.store.addBooking(buildBooking());
      await createSession("FAILED");
      await enable();

      const state = await getState();

      expect(state.status).toBe("SCHEDULED");
      expect(state.session?.status).toBe("FAILED");
    });

    it("reports SCHEDULED for an enabled choice that is not pending and has no session", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);

      const state = await getState();

      expect(state.status).toBe("SCHEDULED");
    });

    it.each<{ status: InMemoryBookingSeed["status"] }>([
      { status: "CANCELLED" },
      { status: "REJECTED" },
    ])("reads the choice as void for a $status booking without writing", async ({ status }) => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ status }));

      const state = await getState();

      expect(state.choice?.enabled).toBe(false);
      expect(state.status).toBeNull();
      expect(state.eligibility.reason).toBe("BOOKING_NOT_ACTIVE");
      expect(state.canToggle).toBe(false);
      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
    });

    it("reports an accepted Meet booking without a stored link as eligible and toggleable", async () => {
      repositories.store.addBooking(
        buildBooking({ status: "ACCEPTED", location: MeetLocationType, metadata: null, references: [] })
      );

      const state = await getState();

      expect(state.eligibility).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
      expect(state.canToggle).toBe(true);
    });

    it("reports FEATURE_DISABLED when the flag is off", async () => {
      repositories.store.addBooking(buildBooking());
      checkIfUserHasFeature.mockResolvedValue(false);

      const state = await getState();

      expect(state.featureEnabled).toBe(false);
      expect(state.eligibility).toEqual({ eligible: false, platform: null, reason: "FEATURE_DISABLED" });
      expect(state.canToggle).toBe(false);
    });

    it("reports FEATURE_DISABLED when the bot provider is unusable", async () => {
      repositories.store.addBooking(buildBooking());
      service = buildService(buildConfig({ botProvider: null }));

      const state = await getState();

      expect(state.featureEnabled).toBe(false);
      expect(state.eligibility).toEqual({ eligible: false, platform: null, reason: "FEATURE_DISABLED" });
      expect(state.canToggle).toBe(false);
    });

    it("gives a granted attendee a read-only view without the choice details", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await repositories.bookingNotetakerRepository.createSharingGrant({
        bookingId: BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
      });

      const state = await getState(ATTENDEE_USER_ID);

      expect(state.viewerRole).toBe("ATTENDEE");
      expect(state.choice).toBeNull();
      expect(state.canToggle).toBe(false);
      expect(state.canStop).toBe(false);
      expect(state.sharedWithAttendees).toBe(true);
      expect(state.status).toBe("SCHEDULED");
    });

    it("disallows toggling after the end time and reports MEETING_ENDED", async () => {
      repositories.store.addBooking(buildBooking());
      vi.setSystemTime(AFTER_END);

      const state = await getState();

      expect(state.canToggle).toBe(false);
      expect(state.eligibility.reason).toBe("MEETING_ENDED");
    });

    it("disallows toggling after the end time even with an enabled choice", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      vi.setSystemTime(AFTER_END);

      const state = await getState();

      expect(state.canToggle).toBe(false);
      expect(state.eligibility.reason).toBe("MEETING_ENDED");
    });

    it("lets the host turn off an enabled choice that is no longer eligible, before the end", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      checkIfUserHasFeature.mockResolvedValue(false);

      const state = await getState();

      expect(state.eligibility.reason).toBe("FEATURE_DISABLED");
      expect(state.canToggle).toBe(true);
    });

    it("maps the transcript and a pending summary", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      const session = await createSession("READY");
      const transcript = await repositories.transcriptRepository.createIfMissing({
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
      await repositories.transcriptRepository.update(transcript.id, {
        language: "en",
        completeness: "COMPLETE",
        durationMs: 60000,
        passageCount: 3,
      });
      await repositories.summaryRepository.upsertPending(transcript.id);

      const state = await getState();

      expect(state.transcript).toEqual({
        id: transcript.id,
        language: "en",
        completeness: "COMPLETE",
        durationMs: 60000,
        passageCount: 3,
      });
      expect(state.summary?.status).toBe("PENDING");
      expect(state.summary?.generatedAt).toBeNull();
    });

    it("maps a ready summary without internal fields", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      const session = await createSession("READY");
      const transcript = await repositories.transcriptRepository.createIfMissing({
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
      await repositories.summaryRepository.upsertPending(transcript.id);
      await repositories.summaryRepository.saveResult(transcript.id, {
        status: "READY",
        language: "en",
        overview: "Overview text",
        keyPoints: ["Point one"],
        decisions: ["Decision one"],
        actionItems: [
          { text: "Send the notes", owner: "Alex" },
          { text: "Book a room", owner: null },
        ],
        model: "test-model",
        generatedAt: new Date("2026-10-12T10:40:00.000Z"),
      });

      const state = await getState();

      expect(state.summary).toEqual({
        status: "READY",
        language: "en",
        overview: "Overview text",
        keyPoints: ["Point one"],
        decisions: ["Decision one"],
        actionItems: [
          { text: "Send the notes", owner: "Alex" },
          { text: "Book a room", owner: null },
        ],
        generatedAt: "2026-10-12T10:40:00.000Z",
      });
    });

    it("hides the transcript and summary once the results were deleted", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      const session = await createSession("READY");
      const transcript = await repositories.transcriptRepository.createIfMissing({
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
      await repositories.summaryRepository.upsertPending(transcript.id);
      await repositories.sessionRepository.setResultsDeletedAtByIds([session.id], NOW);

      const state = await getState();

      expect(state.transcript).toBeNull();
      expect(state.summary).toBeNull();
      expect(state.session?.resultsDeletedAt).toBe(NOW.toISOString());
    });

    it("flags a recurring booking", async () => {
      repositories.store.addBooking(buildBooking({ recurringEventId: "rec-1" }));

      const state = await getState();

      expect(state.isRecurring).toBe(true);
    });

    it("rejects an unknown booking with NotFound", async () => {
      const error = await captureError(getState());

      expect(error.code).toBe(ErrorCode.NotFound);
    });

    it("rejects a stranger with Forbidden", async () => {
      repositories.store.addBooking(buildBooking());

      const error = await captureError(getState(STRANGER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
    });

    it("rejects an attendee without a sharing grant with Forbidden", async () => {
      repositories.store.addBooking(buildBooking());
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      const error = await captureError(getState(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
    });

    it("reports a null setByName when the lookup does not know the user who set the choice", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      users = [];

      const state = await getState();

      expect(state.choice?.setByName).toBeNull();
    });

    it("reports REJOIN_BLOCKED and disallows toggling for a blocked, disabled choice", async () => {
      repositories.store.addBooking(buildBooking());
      await blockDisabledChoice();

      const state = await getState();

      expect(state.eligibility).toEqual({
        eligible: false,
        platform: "GOOGLE_MEET",
        reason: "REJOIN_BLOCKED",
      });
      expect(state.canToggle).toBe(false);
      expect(state.choice?.enabled).toBe(false);
    });

    it("disallows toggling a blocked choice that is still enabled", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);
      await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);

      const state = await getState();

      expect(state.eligibility.reason).toBe("REJOIN_BLOCKED");
      expect(state.canToggle).toBe(false);
      expect(state.choice?.enabled).toBe(true);
    });

    it("keeps canStop for a live session on a blocked booking", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await repositories.bookingNotetakerRepository.clearPendingDispatch(BOOKING_ID);
      await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);
      await createSession("TRANSCRIBING");

      const state = await getState();

      expect(state.eligibility.reason).toBe("REJOIN_BLOCKED");
      expect(state.canStop).toBe(true);
    });

    it("reports REJOIN_BLOCKED before MEETING_ENDED", async () => {
      repositories.store.addBooking(buildBooking());
      await blockEnabledChoice();
      vi.setSystemTime(AFTER_END);

      const state = await getState();

      expect(state.eligibility.reason).toBe("REJOIN_BLOCKED");
      expect(state.canToggle).toBe(false);
    });

    it("disallows toggling a blocked, enabled choice when the feature is off", async () => {
      repositories.store.addBooking(buildBooking());
      await blockEnabledChoice();
      checkIfUserHasFeature.mockResolvedValue(false);

      const state = await getState();

      expect(state.eligibility.reason).toBe("FEATURE_DISABLED");
      expect(state.canToggle).toBe(false);
    });
  });

  describe("getEventTypeDefault", () => {
    const getDefault = () =>
      service.getEventTypeDefault({ eventTypeId: EVENT_TYPE_ID, userId: ORGANIZER_ID });

    it("reports an available default that is off for a Meet event type without a settings row", async () => {
      seedEventType();

      await expect(getDefault()).resolves.toEqual({
        enabledByDefault: false,
        available: true,
        unavailableReason: null,
      });
    });

    it("reports enabledByDefault true once the default is stored", async () => {
      await seedDefaultOn();

      await expect(getDefault()).resolves.toEqual({
        enabledByDefault: true,
        available: true,
        unavailableReason: null,
      });
    });

    it("is available when at least one of several locations is supported", async () => {
      seedEventType({ locations: [{ type: "inPerson" }, { type: MeetLocationType }] });

      const result = await getDefault();

      expect(result.available).toBe(true);
      expect(result.unavailableReason).toBeNull();
    });

    it.each<{ name: string; locations: unknown; reason: NotetakerIneligibilityReasonDto }>([
      { name: "an in-person location", locations: [{ type: "inPerson" }], reason: "UNSUPPORTED_PLATFORM" },
      { name: "Cal Video", locations: [{ type: DailyLocationType }], reason: "CAL_VIDEO" },
      { name: "an empty location list", locations: [], reason: "CAL_VIDEO" },
      { name: "missing locations", locations: null, reason: "CAL_VIDEO" },
    ])("is unavailable with $reason for $name", async ({ locations, reason }) => {
      seedEventType({ locations });

      const result = await getDefault();

      expect(result.available).toBe(false);
      expect(result.unavailableReason).toBe(reason);
    });

    it("reports FEATURE_DISABLED when the flag is off, even with a Meet location", async () => {
      seedEventType();
      checkIfUserHasFeature.mockResolvedValue(false);

      const result = await getDefault();

      expect(result.available).toBe(false);
      expect(result.unavailableReason).toBe("FEATURE_DISABLED");
      expect(checkIfUserHasFeature).toHaveBeenCalledWith(ORGANIZER_ID, "notetaker");
    });

    it("reports FEATURE_DISABLED when the bot provider is unusable", async () => {
      seedEventType();
      service = buildService(buildConfig({ botProvider: null }));

      const result = await getDefault();

      expect(result.available).toBe(false);
      expect(result.unavailableReason).toBe("FEATURE_DISABLED");
    });

    it("rejects an unknown event type with NotFound", async () => {
      const error = await captureError(getDefault());

      expect(error.code).toBe(ErrorCode.NotFound);
    });
  });

  describe("setEventTypeDefault", () => {
    const setDefault = (enabledByDefault: boolean) =>
      service.setEventTypeDefault({ eventTypeId: EVENT_TYPE_ID, enabledByDefault, userId: ORGANIZER_ID });

    it("turns the default on and returns the new state", async () => {
      seedEventType();

      const result = await setDefault(true);

      expect(result).toEqual({ enabledByDefault: true, available: true, unavailableReason: null });
      expect(repositories.store.eventTypeSettings.size).toBe(1);
    });

    it.each<{
      name: string;
      locations: unknown;
      featureEnabled: boolean;
      reason: NotetakerIneligibilityReasonDto;
    }>([
      {
        name: "an in-person location",
        locations: [{ type: "inPerson" }],
        featureEnabled: true,
        reason: "UNSUPPORTED_PLATFORM",
      },
      {
        name: "Cal Video",
        locations: [{ type: DailyLocationType }],
        featureEnabled: true,
        reason: "CAL_VIDEO",
      },
      {
        name: "a user without the flag",
        locations: [{ type: MeetLocationType }],
        featureEnabled: false,
        reason: "FEATURE_DISABLED",
      },
    ])("refuses with $reason when turned on for $name", async ({ locations, featureEnabled, reason }) => {
      seedEventType({ locations });
      checkIfUserHasFeature.mockResolvedValue(featureEnabled);

      const error = await captureError(setDefault(true));

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe(reason);
      expect(error.data).toEqual({ reason });
      expect(repositories.store.eventTypeSettings.size).toBe(0);
    });

    it("turns the default off on an unavailable event type", async () => {
      seedEventType({ locations: [{ type: "inPerson" }] });
      await repositories.eventTypeNotetakerSettingsRepository.upsert({
        eventTypeId: EVENT_TYPE_ID,
        enabledByDefault: true,
      });

      const result = await setDefault(false);

      expect(result.enabledByDefault).toBe(false);
      expect(repositories.store.eventTypeSettings.get(EVENT_TYPE_ID)?.enabledByDefault).toBe(false);
    });

    it("keeps one settings row when turned on twice", async () => {
      seedEventType();

      await setDefault(true);
      await setDefault(true);

      expect(repositories.store.eventTypeSettings.size).toBe(1);
    });

    it("writes no activity, sends no notice and leaves existing choices untouched across a default flip", async () => {
      seedEventType();
      repositories.store.addBooking(buildBooking());
      await enable();
      const before = snapshot();

      await setDefault(true);
      await setDefault(false);

      const after = snapshot();
      expect(after.choices).toEqual(before.choices);
      expect(after.activities).toEqual(before.activities);
      expect(after.notices).toEqual(before.notices);
    });

    it("rejects an unknown event type with NotFound", async () => {
      const error = await captureError(setDefault(true));

      expect(error.code).toBe(ErrorCode.NotFound);
    });
  });

  describe("getDisclosure", () => {
    const getDisclosure = () => service.getDisclosure({ eventTypeId: EVENT_TYPE_ID });

    it("returns exactly enabledByDefault, onBehalfOf and supportedLocationTypes", async () => {
      await seedDefaultOn();

      const result = await getDisclosure();

      expect(Object.keys(result).sort()).toEqual([
        "enabledByDefault",
        "onBehalfOf",
        "supportedLocationTypes",
      ]);
      expect(result).toEqual({
        enabledByDefault: true,
        onBehalfOf: "Organizer",
        supportedLocationTypes: [MeetLocationType],
      });
    });

    it("reports enabledByDefault false without a settings row", async () => {
      seedEventType();

      const result = await getDisclosure();

      expect(result.enabledByDefault).toBe(false);
    });

    it("reports enabledByDefault false when the bot provider is unusable", async () => {
      await seedDefaultOn();
      service = buildService(buildConfig({ botProvider: null }));

      const result = await getDisclosure();

      expect(result.enabledByDefault).toBe(false);
    });

    it("does not consult the per-user flag", async () => {
      await seedDefaultOn();
      checkIfUserHasFeature.mockResolvedValue(false);

      const result = await getDisclosure();

      expect(result.enabledByDefault).toBe(true);
      expect(checkIfUserHasFeature).not.toHaveBeenCalled();
    });

    it("passes a null owner name through", async () => {
      seedEventType({ ownerName: null });

      const result = await getDisclosure();

      expect(result.onBehalfOf).toBeNull();
    });

    it("lists no supported type for an in-person event type", async () => {
      seedEventType({ locations: [{ type: "inPerson" }] });

      const result = await getDisclosure();

      expect(result.supportedLocationTypes).toEqual([]);
    });

    it("reads no booking data", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());
      await enable();

      const result = await getDisclosure();

      expect(result).toEqual({
        enabledByDefault: true,
        onBehalfOf: "Organizer",
        supportedLocationTypes: [MeetLocationType],
      });
    });

    it("rejects an unknown event type with NotFound", async () => {
      const error = await captureError(getDisclosure());

      expect(error.code).toBe(ErrorCode.NotFound);
    });
  });

  describe("onBookingCreated", () => {
    const created = (bookingUid: string = BOOKING_UID) => service.onBookingCreated({ bookingUid });

    it("inherits the default on a supported platform", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());

      await created();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
        source: "EVENT_TYPE_DEFAULT",
        appliedToSeries: false,
        setByUserId: null,
        setAt: NOW,
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId: BOOKING_ID,
        action: "ENABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
        sessionId: null,
        detail: { source: "EVENT_TYPE_DEFAULT" },
      });
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("creates nothing when the default is off", async () => {
      seedEventType();
      await repositories.eventTypeNotetakerSettingsRepository.upsert({
        eventTypeId: EVENT_TYPE_ID,
        enabledByDefault: false,
      });
      repositories.store.addBooking(buildBooking());

      await created();

      expectNothingWritten();
    });

    it("creates nothing when the event type has no settings row", async () => {
      seedEventType();
      repositories.store.addBooking(buildBooking());

      await created();

      expectNothingWritten();
    });

    it("creates nothing for a booking that ended up on Cal Video", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking({ location: DailyLocationType }));

      await created();

      expectNothingWritten();
    });

    it("creates nothing for a booking without an event type", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking({ eventTypeId: null }));

      await created();

      expectNothingWritten();
    });

    it("creates nothing for a booking without an organizer", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));

      await created();

      expectNothingWritten();
    });

    it("creates nothing when the organizer's flag is off", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());
      checkIfUserHasFeature.mockResolvedValue(false);

      await created();

      expect(checkIfUserHasFeature).toHaveBeenCalledWith(ORGANIZER_ID, "notetaker");
      expectNothingWritten();
    });

    it("stores the choice for a PENDING booking on a supported location type", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking({ status: "PENDING", location: MeetLocationType }));

      await created();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
      });
    });

    it("inherits the default on an accepted Meet booking whose link is not stored yet", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(
        buildBooking({ status: "ACCEPTED", location: MeetLocationType, metadata: null, references: [] })
      );

      await created();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
        source: "EVENT_TYPE_DEFAULT",
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        action: "ENABLED",
        actorType: "SYSTEM",
        detail: { source: "EVENT_TYPE_DEFAULT" },
      });
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("does not re-enable a choice a host turned off", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();
      await seedDefaultOn();

      await created();

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({ enabled: false, source: "HOST" });
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
      ]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("writes one activity and one notice when replayed", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());

      await created();
      await created();

      expect(repositories.store.activities).toHaveLength(1);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("logs and returns for an unknown booking", async () => {
      await expect(created("missing")).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][1]).toEqual({ bookingUid: "missing" });
      expectNothingWritten();
    });

    it("logs a failed notice enqueue and keeps the inherited choice", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());
      tasker.sendNotificationRunId = "task-failed";

      await expect(created()).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][1]).toEqual({ bookingId: BOOKING_ID });
      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
    });
  });

  describe("onRecurringOccurrenceCreated", () => {
    const recurringCreated = (bookingUid: string) => service.onRecurringOccurrenceCreated({ bookingUid });

    it("inherits the default on each occurrence and enqueues one notice for the series", async () => {
      await seedDefaultOn();
      seedSeries(2);

      await recurringCreated(BOOKING_UID);
      await recurringCreated("series-uid-1");

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
        appliedToSeries: false,
      });
      expect(repositories.store.choices.get(BOOKING_ID + 1)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
        appliedToSeries: false,
      });
      expect(repositories.store.activities).toHaveLength(2);
      expect(repositories.store.activities.map((activity) => activity.bookingId).sort()).toEqual([
        BOOKING_ID,
        BOOKING_ID + 1,
      ]);
      expect(repositories.store.activities.every((activity) => activity.actorType === "SYSTEM")).toBe(true);
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("enqueues nothing when another occurrence already has a choice, even a disabled one", async () => {
      await seedDefaultOn();
      seedSeries(2);
      await repositories.bookingNotetakerRepository.upsert({
        bookingId: BOOKING_ID,
        enabled: false,
        pendingDispatch: false,
        source: "HOST",
        appliedToSeries: false,
        setByUserId: ORGANIZER_ID,
        setAt: NOW,
      });

      await recurringCreated("series-uid-1");

      expect(repositories.store.choices.get(BOOKING_ID + 1)?.enabled).toBe(true);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("inherits the default on an accepted Meet occurrence whose link is not stored yet", async () => {
      await seedDefaultOn();
      seedSeries(1, {
        0: { status: "ACCEPTED", location: MeetLocationType, metadata: null, references: [] },
      });

      await recurringCreated(BOOKING_UID);

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
        source: "EVENT_TYPE_DEFAULT",
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("behaves as onBookingCreated when the booking has no recurringEventId", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking());

      await recurringCreated(BOOKING_UID);

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("creates nothing with the default off", async () => {
      seedEventType();
      seedSeries(2);

      await recurringCreated(BOOKING_UID);

      expectNothingWritten();
    });

    it("logs and returns for an unknown booking", async () => {
      await expect(recurringCreated("missing")).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][1]).toEqual({ bookingUid: "missing" });
      expectNothingWritten();
    });
  });

  describe("onBookingRescheduled", () => {
    it("copies an enabled choice and re-arms it", async () => {
      seedRescheduledPair();
      await seedOldChoice();
      const oldBefore = structuredClone(repositories.store.choices.get(BOOKING_ID));

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: true,
        pendingDispatch: true,
        source: "HOST",
        appliedToSeries: true,
        setByUserId: CO_HOST_ID,
        setAt: OLD_SET_AT,
        notifiedAttendeeEmails: [ATTENDEE_EMAIL],
        rejoinBlocked: false,
      });
      expect(repositories.store.activities).toHaveLength(1);
      expect(repositories.store.activities[0]).toMatchObject({
        bookingId: NEW_BOOKING_ID,
        action: "ENABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
        detail: { source: "RESCHEDULE", fromBookingUid: BOOKING_UID },
      });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
      expect(repositories.store.choices.get(BOOKING_ID)).toEqual(oldBefore);
    });

    it("does not copy rejoinBlocked", async () => {
      seedRescheduledPair();
      await seedOldChoice();
      await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)?.rejoinBlocked).toBe(false);
    });

    it("copies a disabled choice with no activity and no notice", async () => {
      seedRescheduledPair();
      await seedOldChoice({ enabled: false });

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
      });
      expect(repositories.store.activities).toHaveLength(0);
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("overrides the event-type default with a copied disabled choice", async () => {
      await seedDefaultOn();
      seedRescheduledPair();
      await seedOldChoice({ enabled: false });

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: false,
        source: "HOST",
      });
      expect(tasker.sendNotificationCalls).toHaveLength(0);
    });

    it("keeps the copied source for an inherited choice", async () => {
      seedRescheduledPair();
      await seedOldChoice({ source: "EVENT_TYPE_DEFAULT", setByUserId: null, appliedToSeries: false });

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
        setByUserId: null,
      });
    });

    it("applies the default when the old booking has no choice", async () => {
      await seedDefaultOn();
      seedRescheduledPair();

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
      });
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(NEW_BOOKING_ID)]);
    });

    it("applies the default when the old booking is unknown", async () => {
      await seedDefaultOn();
      repositories.store.addBooking(buildBooking({ id: NEW_BOOKING_ID, uid: NEW_BOOKING_UID }));

      await reschedule();

      expect(repositories.store.choices.get(NEW_BOOKING_ID)).toMatchObject({
        enabled: true,
        source: "EVENT_TYPE_DEFAULT",
      });
    });

    it("creates nothing when the old booking has no choice and the default is off", async () => {
      seedEventType();
      seedRescheduledPair();

      await reschedule();

      expectNothingWritten();
    });

    it("does nothing when the new booking already has a choice", async () => {
      await seedDefaultOn();
      seedRescheduledPair();
      await seedOldChoice();
      await repositories.bookingNotetakerRepository.upsert({
        bookingId: NEW_BOOKING_ID,
        enabled: false,
        pendingDispatch: false,
        source: "HOST",
        appliedToSeries: false,
        setByUserId: ORGANIZER_ID,
        setAt: NOW,
      });
      const before = snapshot();

      await reschedule();

      expect(snapshot()).toEqual(before);
    });

    it("logs and returns for an unknown new booking", async () => {
      await expect(reschedule()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expectNothingWritten();
    });
  });

  describe("onBookingLocationChanged", () => {
    const locationChanged = (bookingId: number = BOOKING_ID) =>
      service.onBookingLocationChanged({ bookingId });

    function turnedOffCalls() {
      return tasker.sendNotificationCalls.filter((call) => call.payload.kind === "TURNED_OFF");
    }

    it("changes nothing when the location is still supported", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
      expect(repositories.store.activities).toHaveLength(1);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it.each<{ name: string; location: string }>([
      { name: "an in-person location", location: "123 Main Street" },
      { name: "an unsupported platform", location: "https://zoom.us/j/123" },
      { name: "Cal Video", location: DailyLocationType },
    ])("turns the choice off for $name", async ({ location }) => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ location }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: true });

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
        setByUserId: ORGANIZER_ID,
      });
      expect(repositories.store.activities[repositories.store.activities.length - 1]).toMatchObject({
        bookingId: BOOKING_ID,
        action: "DISABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
        detail: { reason: "UNSUPPORTED_LOCATION" },
      });
      expect(tasker.sendNotificationCalls[tasker.sendNotificationCalls.length - 1]).toEqual({
        payload: { kind: "TURNED_OFF", bookingId: BOOKING_ID, sessionId: null },
        options: undefined,
      });
    });

    it("sends nothing on a repeat", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ location: "123 Main Street" }));

      await locationChanged();
      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(turnedOffCalls()).toHaveLength(1);
      expect(repositories.store.activities.filter((activity) => activity.action === "DISABLED")).toHaveLength(
        1
      );
    });

    it("changes nothing while the meeting link is pending", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ location: MeetLocationType, references: [] }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
      expect(turnedOffCalls()).toHaveLength(0);
    });

    it.each<{ name: string; overrides: Partial<InMemoryBookingSeed> }>([
      {
        name: "a stale Meet reference",
        overrides: {
          metadata: { videoCallUrl: "" },
          references: [{ type: "google_meet_video", meetingUrl: MEET_LINK }],
        },
      },
      { name: "a stale videoCallUrl", overrides: { metadata: { videoCallUrl: MEET_LINK }, references: [] } },
    ])("turns the choice off for an in-person location that still carries $name", async ({ overrides }) => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ location: "123 Main Street", ...overrides }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: true });

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: false,
        pendingDispatch: false,
      });
      expect(repositories.store.activities[repositories.store.activities.length - 1]).toMatchObject({
        bookingId: BOOKING_ID,
        action: "DISABLED",
        actorType: "SYSTEM",
        detail: { reason: "UNSUPPORTED_LOCATION" },
      });
      expect(turnedOffCalls()).toEqual([
        { payload: { kind: "TURNED_OFF", bookingId: BOOKING_ID, sessionId: null }, options: undefined },
      ]);
    });

    it("changes nothing on a cancelled booking", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ status: "CANCELLED", location: "123 Main Street" }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
      expect(turnedOffCalls()).toHaveLength(0);
    });

    it("changes nothing when the choice is off", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();
      repositories.store.addBooking(buildBooking({ location: "123 Main Street" }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(turnedOffCalls()).toHaveLength(0);
      expect(repositories.store.activities).toHaveLength(2);
    });

    it("changes nothing when there is no choice", async () => {
      repositories.store.addBooking(buildBooking({ location: "123 Main Street" }));

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expectNothingWritten();
    });

    it("changes nothing for an unknown booking and logs it", async () => {
      await expect(locationChanged(999)).resolves.toEqual({ turnedOff: false });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][1]).toEqual({ bookingId: 999 });
      expectNothingWritten();
    });

    it("ignores the feature flag and the end time", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      checkIfUserHasFeature.mockResolvedValue(false);
      vi.setSystemTime(AFTER_END);

      await expect(locationChanged()).resolves.toEqual({ turnedOff: false });

      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(true);
    });

    it("logs a failed turned-off enqueue and still reports turnedOff", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      repositories.store.addBooking(buildBooking({ location: "123 Main Street" }));
      tasker.sendNotificationRunId = "task-failed";

      await expect(locationChanged()).resolves.toEqual({ turnedOff: true });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][1]).toEqual({ bookingId: BOOKING_ID });
      expect(repositories.store.choices.get(BOOKING_ID)?.enabled).toBe(false);
    });
  });

  describe("setEnabled with ALL_FUTURE_OCCURRENCES", () => {
    it("enables this and every later occurrence with appliedToSeries", async () => {
      seedSeries(3);

      await setScope(true);

      for (const bookingId of [100, 101, 102]) {
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          enabled: true,
          pendingDispatch: true,
          source: "HOST",
          appliedToSeries: true,
          setByUserId: ORGANIZER_ID,
        });
        expect(activitiesFor(bookingId)).toHaveLength(1);
        expect(activitiesFor(bookingId)[0]).toMatchObject({
          action: "ENABLED",
          actorType: "USER",
          actorUserId: ORGANIZER_ID,
        });
      }
      expect(tasker.sendNotificationCalls).toEqual([noticeFor(BOOKING_ID)]);
    });

    it("leaves earlier occurrences untouched", async () => {
      seedSeries(3);

      await setScope(true, "series-uid-1");

      expect(repositories.store.choices.has(BOOKING_ID)).toBe(false);
      expect(repositories.store.choices.get(BOOKING_ID + 1)?.enabled).toBe(true);
      expect(repositories.store.choices.get(BOOKING_ID + 2)?.enabled).toBe(true);
      expect(activitiesFor(BOOKING_ID)).toHaveLength(0);
    });

    it("skips cancelled, rejected and ended occurrences", async () => {
      seedSeries(5, {
        0: {
          startTime: new Date("2026-10-12T08:00:00.000Z"),
          endTime: new Date("2026-10-12T09:30:00.000Z"),
        },
        1: { status: "CANCELLED" },
        2: { status: "REJECTED" },
        3: {
          startTime: new Date("2026-10-12T08:30:00.000Z"),
          endTime: new Date("2026-10-12T08:45:00.000Z"),
        },
      });

      await setScope(true);

      expect(Array.from(repositories.store.choices.keys()).sort()).toEqual([100, 104]);
      expect(activitiesFor(101)).toHaveLength(0);
      expect(activitiesFor(102)).toHaveLength(0);
      expect(activitiesFor(103)).toHaveLength(0);
    });

    it("skips a rejoin-blocked occurrence and still enables the others", async () => {
      seedSeries(3);
      await repositories.bookingNotetakerRepository.upsert({
        bookingId: 101,
        enabled: false,
        pendingDispatch: false,
        source: "HOST",
        appliedToSeries: false,
        setByUserId: ORGANIZER_ID,
        setAt: NOW,
      });
      await repositories.bookingNotetakerRepository.setRejoinBlocked(101, true);

      await expect(setScope(true)).resolves.toBeUndefined();

      expect(repositories.store.choices.get(101)).toMatchObject({ enabled: false, rejoinBlocked: true });
      expect(activitiesFor(101)).toHaveLength(0);
      expect(repositories.store.choices.get(102)?.enabled).toBe(true);
      expect(repositories.store.choices.get(100)?.enabled).toBe(true);
    });

    it("flags an already enabled occurrence without rewriting it", async () => {
      seedSeries(3, {
        1: {
          attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
          eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
        },
      });
      await service.setEnabled({
        bookingUid: "series-uid-1",
        enabled: true,
        scope: "THIS_BOOKING",
        userId: CO_HOST_ID,
      });
      await repositories.bookingNotetakerRepository.clearPendingDispatch(101);
      const activitiesBefore = activitiesFor(101).length;

      await setScope(true);

      expect(repositories.store.choices.get(101)).toMatchObject({
        enabled: true,
        appliedToSeries: true,
        setByUserId: CO_HOST_ID,
        pendingDispatch: false,
      });
      expect(activitiesFor(101)).toHaveLength(activitiesBefore);
    });

    it("flags this booking and still enables the series when this booking is already on", async () => {
      seedSeries(3);
      await enable();
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));

      await setScope(true);

      expect(repositories.store.choices.get(BOOKING_ID)).toMatchObject({
        enabled: true,
        appliedToSeries: true,
        setAt: NOW,
      });
      expect(activitiesFor(BOOKING_ID)).toHaveLength(1);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
      expect(repositories.store.choices.get(101)?.enabled).toBe(true);
      expect(repositories.store.choices.get(102)?.enabled).toBe(true);
    });

    it("checks eligibility once, on the toggled booking", async () => {
      seedSeries(3, { 1: { location: "123 Main Street" } });

      await expect(setScope(true)).resolves.toBeUndefined();

      expect(repositories.store.choices.get(101)?.enabled).toBe(true);
    });

    it("refuses and writes nothing when the toggled booking is ineligible", async () => {
      seedSeries(3, { 0: { location: DailyLocationType } });

      const error = await captureError(setScope(true));

      expect(error.code).toBe(ErrorCode.BadRequest);
      expect(error.message).toBe("CAL_VIDEO");
      expectNothingWritten();
    });

    it("disables this and every later occurrence, one activity per affected booking", async () => {
      seedSeries(3);
      await setScope(true);
      await repositories.bookingNotetakerRepository.appendNotifiedAttendeeEmails(101, [ATTENDEE_EMAIL], NOW);

      await setScope(false);

      for (const bookingId of [100, 101, 102]) {
        expect(repositories.store.choices.get(bookingId)).toMatchObject({
          enabled: false,
          pendingDispatch: false,
          appliedToSeries: true,
        });
        const disabled = activitiesFor(bookingId).filter((activity) => activity.action === "DISABLED");
        expect(disabled).toHaveLength(1);
        expect(disabled[0]).toMatchObject({ actorType: "USER", actorUserId: ORGANIZER_ID });
      }
      expect(repositories.store.choices.get(101)?.notifiedAttendeeEmails).toEqual([ATTENDEE_EMAIL]);
      expect(tasker.sendNotificationCalls).toHaveLength(1);
    });

    it("writes nothing for a later occurrence that has no choice or is already off", async () => {
      seedSeries(3);
      await enable();
      await repositories.bookingNotetakerRepository.upsert({
        bookingId: 101,
        enabled: false,
        pendingDispatch: false,
        source: "HOST",
        appliedToSeries: false,
        setByUserId: CO_HOST_ID,
        setAt: OLD_SET_AT,
      });
      const offRowBefore = structuredClone(repositories.store.choices.get(101));

      await setScope(false);

      expect(repositories.store.choices.has(102)).toBe(false);
      expect(repositories.store.choices.get(101)).toEqual(offRowBefore);
      expect(activitiesFor(101)).toHaveLength(0);
      expect(repositories.store.activities.filter((activity) => activity.action === "DISABLED")).toHaveLength(
        1
      );
    });

    it("still disables later occurrences when this booking is already off", async () => {
      seedSeries(3);
      await enable();
      await disable();
      await service.setEnabled({
        bookingUid: "series-uid-1",
        enabled: true,
        scope: "THIS_BOOKING",
        userId: ORGANIZER_ID,
      });

      await setScope(false);

      expect(repositories.store.choices.get(101)).toMatchObject({ enabled: false, appliedToSeries: true });
      expect(activitiesFor(101).map((activity) => activity.action)).toEqual(["ENABLED", "DISABLED"]);
      expect(activitiesFor(BOOKING_ID)).toHaveLength(2);
    });

    it("does not touch an occurrence that already ended", async () => {
      seedSeries(3);
      await setScope(true);
      vi.setSystemTime(new Date(AFTER_END.getTime() + WEEK_MS));

      await setScope(false);

      expect(repositories.store.choices.get(100)?.enabled).toBe(false);
      expect(repositories.store.choices.get(101)?.enabled).toBe(true);
      expect(activitiesFor(101).filter((activity) => activity.action === "DISABLED")).toHaveLength(0);
      expect(repositories.store.choices.get(102)?.enabled).toBe(false);
    });

    it("equals THIS_BOOKING on a non-recurring booking when enabling", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      const expected = snapshot();
      resetServices();
      repositories.store.addBooking(buildBooking());

      await setScope(true);

      expect(snapshot()).toEqual(expected);
      expect(repositories.store.choices.get(BOOKING_ID)?.appliedToSeries).toBe(false);
    });

    it("equals THIS_BOOKING on a non-recurring booking when disabling", async () => {
      repositories.store.addBooking(buildBooking());
      await enable();
      await disable();
      const expected = snapshot();
      resetServices();
      repositories.store.addBooking(buildBooking());
      await enable();

      await setScope(false);

      expect(snapshot()).toEqual(expected);
    });
  });

  describe("getState for a granted attendee", () => {
    async function seedSharedResults(): Promise<{ transcriptId: string }> {
      repositories.store.addBooking(buildBooking());
      await enable();
      const session = await createSession("READY");
      const transcript = await repositories.transcriptRepository.createIfMissing({
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
      await repositories.summaryRepository.upsertPending(transcript.id);
      await repositories.bookingNotetakerRepository.createSharingGrant({
        bookingId: BOOKING_ID,
        grantedByUserId: ORGANIZER_ID,
      });
      checkIfUserHasFeature.mockReset();
      checkIfUserHasFeature.mockResolvedValue(false);
      return { transcriptId: transcript.id };
    }

    it("returns the shared results although the feature is off for everyone", async () => {
      const { transcriptId } = await seedSharedResults();
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      const state = await getState(ATTENDEE_USER_ID);

      expect(state.viewerRole).toBe("ATTENDEE");
      expect(state.featureEnabled).toBe(true);
      expect(state.eligibility).toEqual({ eligible: true, platform: "GOOGLE_MEET", reason: null });
      expect(state.transcript?.id).toBe(transcriptId);
      expect(state.summary?.status).toBe("PENDING");
      expect(state.choice).toBeNull();
      expect(state.canToggle).toBe(false);
      expect(state.canStop).toBe(false);
      expect(state.sharedWithAttendees).toBe(true);
    });

    it("does not evaluate the attendee's feature flag", async () => {
      await seedSharedResults();
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      await getState(ATTENDEE_USER_ID);

      expect(checkIfUserHasFeature).not.toHaveBeenCalled();
    });

    it("reports the feature as off when the bot provider is unusable but still returns the results", async () => {
      await seedSharedResults();
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      service = buildService(buildConfig({ botProvider: null }));

      const state = await getState(ATTENDEE_USER_ID);

      expect(state.viewerRole).toBe("ATTENDEE");
      expect(state.featureEnabled).toBe(false);
      expect(state.transcript).not.toBeNull();
      expect(state.summary).not.toBeNull();
      expect(checkIfUserHasFeature).not.toHaveBeenCalled();
    });

    it("still gates a host on their own feature flag", async () => {
      const { transcriptId } = await seedSharedResults();

      const state = await getState();

      expect(state.viewerRole).toBe("HOST");
      expect(state.featureEnabled).toBe(false);
      expect(state.eligibility.reason).toBe("FEATURE_DISABLED");
      expect(checkIfUserHasFeature).toHaveBeenCalledWith(ORGANIZER_ID, "notetaker");
      expect(state.transcript?.id).toBe(transcriptId);
    });

    it("rejects an attendee when the host did not share the results", async () => {
      await seedSharedResults();
      await repositories.bookingNotetakerRepository.deleteSharingGrant(BOOKING_ID);
      repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      const error = await captureError(getState(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
    });

    it.each([
      { name: "has no verified email", emails: null },
      { name: "has only a verified email that is not on the booking", emails: ["someone-else@example.com"] },
    ])("rejects a granted attendee who $name", async ({ emails }) => {
      await seedSharedResults();
      if (emails) repositories.store.setVerifiedEmails(ATTENDEE_USER_ID, emails);

      const error = await captureError(getState(ATTENDEE_USER_ID));

      expect(error.code).toBe(ErrorCode.Forbidden);
    });
  });
});
