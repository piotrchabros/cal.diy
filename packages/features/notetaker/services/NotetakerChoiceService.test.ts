import { DailyLocationType, MeetLocationType } from "@calcom/app-store/constants";
import type {
  NotetakerIneligibilityReasonDto,
  NotetakerSessionStatusDto,
} from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotetakerConfig } from "../lib/config";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
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

describe("NotetakerChoiceService", () => {
  const checkIfUserHasFeature = vi.fn(async (_userId: number, _slug: string): Promise<boolean> => true);
  let users: NotetakerUserRecord[];
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let service: NotetakerChoiceService;

  function buildService(config: NotetakerConfig = buildConfig()): NotetakerChoiceService {
    const { bookingNotetakerRepository } = repositories;
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

  function expectNothingWritten(): void {
    expect(repositories.store.choices.size).toBe(0);
    expect(repositories.store.activities).toHaveLength(0);
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    checkIfUserHasFeature.mockReset();
    checkIfUserHasFeature.mockResolvedValue(true);
    users = [userRecord(ORGANIZER_ID, "Organizer"), userRecord(CO_HOST_ID, "Co Host")];
    repositories = createInMemoryNotetakerRepositories();
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
      {
        name: "a Google Meet location without a link",
        overrides: { location: MeetLocationType, status: "ACCEPTED", references: [] },
        reason: "NO_MEETING_LINK",
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
      await disable();

      await enable();

      expect(repositories.store.choices.get(BOOKING_ID)?.pendingDispatch).toBe(true);
      expect(repositories.store.activities.map((activity) => activity.action)).toEqual([
        "ENABLED",
        "DISABLED",
        "ENABLED",
      ]);
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

    it("treats ALL_FUTURE_OCCURRENCES as THIS_BOOKING", async () => {
      repositories.store.addBooking(buildBooking({ recurringEventId: "rec-1" }));
      repositories.store.addBooking(
        buildBooking({ id: 101, uid: "booking-uid-2", recurringEventId: "rec-1" })
      );

      await service.setEnabled({
        bookingUid: BOOKING_UID,
        enabled: true,
        scope: "ALL_FUTURE_OCCURRENCES",
        userId: ORGANIZER_ID,
      });

      expect(Array.from(repositories.store.choices.keys())).toEqual([BOOKING_ID]);
      expect(repositories.store.choices.get(BOOKING_ID)?.appliedToSeries).toBe(false);
    });

    it("snapshots a null actor name when the acting user is unknown to the lookup", async () => {
      repositories.store.addBooking(buildBooking());
      users = [];

      await enable();

      expect(repositories.store.activities[0].actorName).toBeNull();
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
  });
});
