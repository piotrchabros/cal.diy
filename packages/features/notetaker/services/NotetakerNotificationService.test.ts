import {
  sendNotetakerAdmitPromptEmail,
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerFailedEmail,
  sendNotetakerResultsReadyEmail,
  sendNotetakerTurnedOffEmail,
} from "@calcom/emails/notetaker-email-service";
import { sendNotification } from "@calcom/features/notifications/sendNotification";
import { getTranslation } from "@calcom/i18n/server";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { createInstance, type TFunction } from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type {
  BookingNotetakerRecord,
  NotetakerAttendeeRecord,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import {
  NOTETAKER_ADMIT_PROMPT_PUSH_TYPE,
  NotetakerNotificationService,
} from "./NotetakerNotificationService";

vi.mock("@calcom/emails/notetaker-email-service", () => ({
  sendNotetakerAdmitPromptEmail: vi.fn(),
  sendNotetakerAttendeeNoticeEmail: vi.fn(),
  sendNotetakerFailedEmail: vi.fn(),
  sendNotetakerResultsReadyEmail: vi.fn(),
  sendNotetakerTurnedOffEmail: vi.fn(),
}));
// The real module configures web push at import time.
vi.mock("@calcom/features/notifications/sendNotification", () => ({ sendNotification: vi.fn() }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn() }));

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const OTHER_BOOKING_ID = 200;
const ORGANIZER_ID = 1;
const SECOND_HOST_ID = 2;
const THIRD_USER_ID = 3;

const SECRET_PASSAGE = "SECRET-PASSAGE-TEXT";
const SECRET_OVERVIEW = "SECRET-SUMMARY-OVERVIEW";
const SECRET_KEY_POINT = "SECRET-KEY-POINT";
const SECRET_ACTION_ITEM = "SECRET-ACTION-ITEM";
const SECRETS = [SECRET_PASSAGE, SECRET_OVERVIEW, SECRET_KEY_POINT, SECRET_ACTION_ITEM];

const INPUT_FIELDS = [
  "bookingStartTime",
  "bookingTitle",
  "locale",
  "outcomeReason",
  "resultsUrl",
  "sessionStatus",
  "summaryStatus",
  "t",
  "timeZone",
  "to",
  "transcriptCompleteness",
];

const NOTICE_INPUT_FIELDS: string[] = [
  "bookingStartTime",
  "bookingTitle",
  "hostName",
  "isPending",
  "locale",
  "t",
  "timeZone",
  "to",
];

const ADMIT_INPUT_FIELDS: string[] = [
  "bookingStartTime",
  "bookingTitle",
  "locale",
  "notetakerUrl",
  "t",
  "timeZone",
  "to",
];

const FAILED_INPUT_FIELDS: string[] = [
  "bookingStartTime",
  "bookingTitle",
  "canEnableAgain",
  "locale",
  "notetakerUrl",
  "outcomeReason",
  "t",
  "timeZone",
  "to",
];

const TURNED_OFF_INPUT_FIELDS: string[] = [
  "bookingStartTime",
  "bookingTitle",
  "locale",
  "notetakerUrl",
  "t",
  "timeZone",
  "to",
];

const PUSH_FIELDS: string[] = ["body", "requireInteraction", "subscription", "title", "type", "url"];

const OUTCOME_REASONS: NotetakerOutcomeReasonDto[] = [
  "NOT_ADMITTED",
  "MEETING_DID_NOT_START",
  "NO_SPEECH_DETECTED",
  "REMOVED_BY_PARTICIPANT",
  "STOPPED_BY_HOST",
  "INTERRUPTED",
  "LENGTH_LIMIT_REACHED",
  "MEETING_LINK_UNUSABLE",
];

const NOTETAKER_URL = `${WEBAPP_URL}/booking/${BOOKING_UID}/notetaker`;
const BOOKING_END: Date = new Date("2026-10-12T10:30:00.000Z");
const NOW: Date = new Date("2026-10-10T08:00:00.000Z");
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";

const translators = new Map<string, TFunction>();

function translatorFor(locale: string): TFunction {
  const existing = translators.get(locale);
  if (existing) return existing;
  const instance = createInstance();
  instance.init({
    lng: locale,
    resources: {
      [locale]: {
        common: {
          notetaker_admit_push_title: `PUSH-TITLE[${locale}]`,
          notetaker_admit_push_body: `PUSH-BODY[${locale}] {{title}}`,
        },
      },
    },
  });
  const translator = instance.getFixedT(locale, "common");
  translators.set(locale, translator);
  return translator;
}

class FakeUserLookup implements INotetakerUserLookup {
  users: NotetakerUserRecord[] = [];
  calls: number[][] = [];

  async findByIds({ ids }: { ids: number[] }): Promise<NotetakerUserRecord[]> {
    this.calls.push(ids);
    return this.users.filter((user) => ids.includes(user.id));
  }
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

function buildSubscription(tag: string): { endpoint: string; keys: { auth: string; p256dh: string } } {
  return {
    endpoint: `https://push.example.com/SECRET-ENDPOINT-${tag}`,
    keys: { auth: `SECRET-AUTH-${tag}`, p256dh: `SECRET-P256DH-${tag}` },
  };
}

// Browsers serialize a subscription with an expirationTime the service must not forward.
function storedSubscription(tag: string): string {
  return JSON.stringify({ ...buildSubscription(tag), expirationTime: null });
}

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
    attendeeEmails: [],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

describe("NotetakerNotificationService", () => {
  const sendMock = vi.mocked(sendNotetakerResultsReadyEmail);
  const noticeMock = vi.mocked(sendNotetakerAttendeeNoticeEmail);
  const admitMock = vi.mocked(sendNotetakerAdmitPromptEmail);
  const failedMock = vi.mocked(sendNotetakerFailedEmail);
  const turnedOffMock = vi.mocked(sendNotetakerTurnedOffEmail);
  const pushMock = vi.mocked(sendNotification);
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let userLookup: FakeUserLookup;
  let service: NotetakerNotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTranslation).mockImplementation(async (locale) => translatorFor(locale));
    sendMock.mockResolvedValue(undefined);
    noticeMock.mockResolvedValue(undefined);
    admitMock.mockResolvedValue(undefined);
    failedMock.mockResolvedValue(undefined);
    turnedOffMock.mockResolvedValue(undefined);
    pushMock.mockResolvedValue(undefined);

    repositories = createInMemoryNotetakerRepositories();
    userLookup = new FakeUserLookup();
    service = new NotetakerNotificationService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      activityRepository: repositories.activityRepository,
      sessionRepository: repositories.sessionRepository,
      transcriptRepository: repositories.transcriptRepository,
      summaryRepository: repositories.summaryRepository,
      userRepository: userLookup,
      logger,
    });
    repositories.store.addBooking(buildBooking());
  });

  async function seedSession(
    options: {
      bookingId?: number;
      status?: NotetakerSessionStatusDto;
      outcomeReason?: NotetakerOutcomeReasonDto | null;
    } = {}
  ): Promise<string> {
    const session = await repositories.sessionRepository.create({
      bookingId: options.bookingId ?? BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      status: options.status ?? "READY",
      outcomeReason: options.outcomeReason ?? null,
      endedAt: new Date("2026-10-12T10:30:00.000Z"),
    });
    return session.id;
  }

  async function seedTranscript(
    sessionId: string,
    options: { completeness?: NotetakerTranscriptCompletenessDto } = {}
  ): Promise<string> {
    const transcript = await repositories.transcriptRepository.createIfMissing({
      sessionId,
      bookingId: BOOKING_ID,
    });
    await repositories.transcriptRepository.insertPassages(transcript.id, [
      {
        index: 0,
        speakerKey: "speaker-1",
        speakerName: "Speaker",
        unknownSpeakerNumber: null,
        startMs: 0,
        endMs: 1000,
        text: SECRET_PASSAGE,
        language: "en",
      },
    ]);
    await repositories.transcriptRepository.update(transcript.id, {
      completeness: options.completeness ?? "COMPLETE",
      passageCount: 1,
    });
    return transcript.id;
  }

  async function seedSummary(transcriptId: string, status: NotetakerSummaryStatusDto): Promise<void> {
    await repositories.summaryRepository.upsertPending(transcriptId);
    if (status === "READY") {
      await repositories.summaryRepository.saveResult(transcriptId, {
        status: "READY",
        language: "en",
        overview: SECRET_OVERVIEW,
        keyPoints: [SECRET_KEY_POINT],
        decisions: [],
        actionItems: [{ text: SECRET_ACTION_ITEM, owner: null }],
        model: "model-1",
        generatedAt: new Date("2026-10-12T10:40:00.000Z"),
      });
      return;
    }
    await repositories.summaryRepository.setStatus(transcriptId, status, "x");
  }

  async function seedReadySession(): Promise<string> {
    const sessionId = await seedSession();
    await seedTranscript(sessionId);
    return sessionId;
  }

  async function seedEnabled(actorUserId: number | null): Promise<void> {
    await repositories.activityRepository.create({
      bookingId: BOOKING_ID,
      sessionId: null,
      action: "ENABLED",
      actorType: actorUserId === null ? "SYSTEM" : "USER",
      actorUserId,
      actorName: null,
      detail: null,
    });
  }

  async function seedChoice(
    options: { bookingId?: number; enabled?: boolean; notifiedAttendeeEmails?: string[] } = {}
  ): Promise<void> {
    await repositories.bookingNotetakerRepository.upsert({
      bookingId: options.bookingId ?? BOOKING_ID,
      enabled: options.enabled ?? true,
      pendingDispatch: true,
      source: "HOST",
      appliedToSeries: false,
      setByUserId: ORGANIZER_ID,
      setAt: new Date("2026-10-09T09:00:00.000Z"),
      notifiedAttendeeEmails: options.notifiedAttendeeEmails,
    });
  }

  function setSubscription(userId: number, ...values: string[]): void {
    repositories.store.setWebPushSubscriptions(userId, values);
  }

  async function seedHosts(...userIds: number[]): Promise<void> {
    userLookup.users = userIds.map((id) => buildUser(id));
    for (const id of userIds) await seedEnabled(id);
  }

  function sendAdmit(sessionId: string | null, bookingId: number = BOOKING_ID): Promise<void> {
    return service.send({ kind: "ADMIT_PROMPT", bookingId, sessionId });
  }

  function sendFailedNotice(sessionId: string | null, bookingId: number = BOOKING_ID): Promise<void> {
    return service.send({ kind: "FAILED", bookingId, sessionId });
  }

  function send(sessionId: string | null, bookingId: number = BOOKING_ID): Promise<void> {
    return service.send({ kind: "RESULTS_READY", bookingId, sessionId });
  }

  function sentInputFor(email: string): Parameters<typeof sendNotetakerResultsReadyEmail>[0] {
    const call = sendMock.mock.calls.find(([input]) => input.to.email === email);
    if (!call) throw new Error(`No email was sent to ${email}`);
    return call[0];
  }

  function loggedText(): string {
    return JSON.stringify([
      logger.debug.mock.calls,
      logger.error.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
  }

  function loggerWasCalled(): boolean {
    return [logger.debug, logger.error, logger.info, logger.warn].some((fn) => fn.mock.calls.length > 0);
  }

  describe("RESULTS_READY recipients", () => {
    it("emails each distinct host who enabled the notetaker once and nobody else", async () => {
      userLookup.users = [buildUser(1), buildUser(2), buildUser(3)];
      await seedEnabled(1);
      await seedEnabled(2);
      await seedEnabled(1);
      await repositories.activityRepository.create({
        bookingId: BOOKING_ID,
        sessionId: null,
        action: "DISABLED",
        actorType: "USER",
        actorUserId: THIRD_USER_ID,
        actorName: null,
        detail: null,
      });
      const sessionId = await seedReadySession();

      await send(sessionId);

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sendMock.mock.calls.map(([input]) => input.to.email).sort()).toEqual([
        "user1@example.com",
        "user2@example.com",
      ]);
    });

    it("sends an inherited choice to the organizer", async () => {
      userLookup.users = [buildUser(ORGANIZER_ID), buildUser(SECOND_HOST_ID)];
      await seedEnabled(null);
      const sessionId = await seedReadySession();

      await send(sessionId);

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].to.email).toBe("user1@example.com");
      expect(userLookup.calls).toEqual([[ORGANIZER_ID]]);
    });

    it("sends nothing and logs when an inherited choice has no organizer", async () => {
      repositories.store.removeBooking(BOOKING_ID);
      repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));
      userLookup.users = [buildUser(ORGANIZER_ID)];
      await seedEnabled(null);
      const sessionId = await seedReadySession();

      await expect(send(sessionId)).resolves.toBeUndefined();

      expect(sendMock).not.toHaveBeenCalled();
      expect(loggerWasCalled()).toBe(true);
    });

    it("uses the recipient locale and time zone and falls back to English", async () => {
      userLookup.users = [
        buildUser(1, { locale: "de", timeZone: "Europe/Berlin" }),
        buildUser(2, { locale: null, timeZone: "America/New_York" }),
      ];
      await seedEnabled(1);
      await seedEnabled(2);
      const sessionId = await seedReadySession();

      await send(sessionId);

      expect(getTranslation).toHaveBeenCalledWith("de", "common");
      expect(getTranslation).toHaveBeenCalledWith("en", "common");
      const first = sentInputFor("user1@example.com");
      expect(first.locale).toBe("de");
      expect(first.timeZone).toBe("Europe/Berlin");
      expect(first.t).toBe(translatorFor("de"));
      const second = sentInputFor("user2@example.com");
      expect(second.locale).toBe("en");
      expect(second.timeZone).toBe("America/New_York");
      expect(second.t).toBe(translatorFor("en"));
    });

    it("skips a user the lookup does not return", async () => {
      userLookup.users = [buildUser(1)];
      await seedEnabled(1);
      await seedEnabled(2);
      const sessionId = await seedReadySession();

      await expect(send(sessionId)).resolves.toBeUndefined();

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].to.email).toBe("user1@example.com");
    });
  });

  describe("RESULTS_READY content", () => {
    beforeEach(async () => {
      userLookup.users = [buildUser(1)];
      await seedEnabled(1);
    });

    it("links to the booking notetaker page with the meeting title and start", async () => {
      const sessionId = await seedReadySession();

      await send(sessionId);

      const input = sendMock.mock.calls[0][0];
      expect(input.resultsUrl).toBe(`${WEBAPP_URL}/booking/booking-uid-1/notetaker`);
      expect(input.bookingTitle).toBe("Planning call");
      expect(input.bookingStartTime).toEqual(new Date("2026-10-12T10:00:00.000Z"));
    });

    it("passes the session outcome, transcript completeness and summary status through", async () => {
      const sessionId = await seedSession({
        status: "ENDED_EARLY",
        outcomeReason: "REMOVED_BY_PARTICIPANT",
      });
      const transcriptId = await seedTranscript(sessionId, { completeness: "TRUNCATED" });
      await seedSummary(transcriptId, "FAILED");

      await send(sessionId);

      const input = sendMock.mock.calls[0][0];
      expect(input.sessionStatus).toBe("ENDED_EARLY");
      expect(input.outcomeReason).toBe("REMOVED_BY_PARTICIPANT");
      expect(input.transcriptCompleteness).toBe("TRUNCATED");
      expect(input.summaryStatus).toBe("FAILED");
    });

    it("passes a null summary status when no summary row exists", async () => {
      const sessionId = await seedReadySession();

      await send(sessionId);

      expect(sendMock.mock.calls[0][0].summaryStatus).toBeNull();
    });

    it("passes a READY summary status", async () => {
      const sessionId = await seedSession();
      const transcriptId = await seedTranscript(sessionId);
      await seedSummary(transcriptId, "READY");

      await send(sessionId);

      expect(sendMock.mock.calls[0][0].summaryStatus).toBe("READY");
    });

    it("never passes passage or summary text to the email or the logger", async () => {
      const sessionId = await seedSession();
      const transcriptId = await seedTranscript(sessionId);
      await seedSummary(transcriptId, "READY");

      await send(sessionId);

      const input = sendMock.mock.calls[0][0];
      expect(Object.keys(input).sort()).toEqual(INPUT_FIELDS);
      // JSON.stringify drops the translator function, which is not part of the data under test.
      const sent = JSON.stringify(sendMock.mock.calls);
      for (const secret of SECRETS) {
        expect(sent).not.toContain(secret);
        expect(loggedText()).not.toContain(secret);
      }
    });
  });

  describe("RESULTS_READY unusable targets", () => {
    beforeEach(() => {
      userLookup.users = [buildUser(1)];
    });

    it("resolves without sending or looking up users for an unknown booking", async () => {
      await expect(send("missing", 999)).resolves.toBeUndefined();

      expect(sendMock).not.toHaveBeenCalled();
      expect(userLookup.calls).toEqual([]);
    });

    it.each([
      {
        name: "a null session id",
        arrange: async (): Promise<string | null> => null,
      },
      {
        name: "an unknown session id",
        arrange: async (): Promise<string | null> => "missing",
      },
      {
        name: "a session of another booking",
        arrange: async (): Promise<string | null> => {
          repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: "booking-uid-2" }));
          return seedSession({ bookingId: OTHER_BOOKING_ID });
        },
      },
      {
        name: "a session that is still processing",
        arrange: async (): Promise<string | null> => {
          const sessionId = await seedSession({ status: "PROCESSING" });
          await seedTranscript(sessionId);
          return sessionId;
        },
      },
      {
        name: "a ready session without a transcript row",
        arrange: async (): Promise<string | null> => seedSession(),
      },
      {
        name: "a ready session whose results were deleted",
        arrange: async (): Promise<string | null> => {
          const sessionId = await seedReadySession();
          await repositories.sessionRepository.update(sessionId, { resultsDeletedAt: new Date() });
          return sessionId;
        },
      },
    ])("resolves without sending and logs for $name", async ({ arrange }) => {
      await seedEnabled(1);
      const sessionId = await arrange();

      await expect(send(sessionId)).resolves.toBeUndefined();

      expect(sendMock).not.toHaveBeenCalled();
      expect(loggerWasCalled()).toBe(true);
    });
  });

  describe("other notification kinds", () => {
    it.each(["SHARED_WITH_ATTENDEES"] as const)("rejects %s as having no handler", async (kind) => {
      const promise = service.send({ kind, bookingId: BOOKING_ID, sessionId: null });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
      await expect(promise).rejects.toThrow(kind);
      expect(sendMock).not.toHaveBeenCalled();
      expect(noticeMock).not.toHaveBeenCalled();
      expect(admitMock).not.toHaveBeenCalled();
      expect(failedMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe("RESULTS_READY failures", () => {
    it("keeps emailing the other recipients when one send fails, then rejects", async () => {
      userLookup.users = [buildUser(1), buildUser(2)];
      await seedEnabled(1);
      await seedEnabled(2);
      const sessionId = await seedReadySession();
      sendMock.mockRejectedValueOnce(new Error("render failed"));

      const promise = send(sessionId);

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("ATTENDEE_NOTICE", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function buildAttendee(
      email: string,
      overrides: Partial<NotetakerAttendeeRecord> = {}
    ): NotetakerAttendeeRecord {
      return { email, name: "Guest Person", locale: "en", timeZone: "UTC", ...overrides };
    }

    function setAttendees(attendees: NotetakerAttendeeRecord[], bookingId: number = BOOKING_ID): void {
      repositories.store.setAttendees(bookingId, attendees);
    }

    function sendNotice(bookingId: number = BOOKING_ID, sessionId: string | null = null): Promise<void> {
      return service.send({ kind: "ATTENDEE_NOTICE", bookingId, sessionId });
    }

    function noticedEmails(): string[] {
      return noticeMock.mock.calls.map(([input]) => input.to.email);
    }

    function storedChoice(): Promise<BookingNotetakerRecord | null> {
      return repositories.bookingNotetakerRepository.findByBookingId(BOOKING_ID);
    }

    function failFor(email: string): void {
      noticeMock.mockImplementation(async (input) => {
        if (input.to.email === email) throw new Error("render failed");
      });
    }

    describe("recipients", () => {
      it("emails every current attendee once", async () => {
        await seedChoice();
        setAttendees([buildAttendee(ANN), buildAttendee(BOB), buildAttendee(CY)]);

        await sendNotice();

        expect(noticedEmails()).toEqual([ANN, BOB, CY]);
        expect(sendMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
      });

      it("skips attendees already on the booking's own notified list", async () => {
        await seedChoice({ notifiedAttendeeEmails: [ANN] });
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);

        await sendNotice();

        expect(noticedEmails()).toEqual([BOB]);
      });

      it("skips attendees notified on another booking of the same series", async () => {
        repositories.store.addBooking(buildBooking({ recurringEventId: "series-1" }));
        repositories.store.addBooking(
          buildBooking({ id: OTHER_BOOKING_ID, uid: "booking-uid-2", recurringEventId: "series-1" })
        );
        await seedChoice();
        await seedChoice({ bookingId: OTHER_BOOKING_ID, notifiedAttendeeEmails: [ANN] });
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);

        await sendNotice();

        expect(noticedEmails()).toEqual([BOB]);
      });

      it("does not look across bookings when there is no series", async () => {
        const seriesLookup = vi.spyOn(
          repositories.bookingNotetakerRepository,
          "findNotifiedAttendeeEmailsByRecurringEventId"
        );
        repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: "booking-uid-2" }));
        await seedChoice();
        await seedChoice({ bookingId: OTHER_BOOKING_ID, notifiedAttendeeEmails: [ANN] });
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);

        await sendNotice();

        expect(noticedEmails()).toEqual([ANN, BOB]);
        expect(seriesLookup).not.toHaveBeenCalled();
      });

      it("compares addresses trimmed and case-insensitively", async () => {
        await seedChoice({ notifiedAttendeeEmails: [" ANN@Example.COM "] });
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        expect(noticeMock).not.toHaveBeenCalled();
      });

      it("emails a duplicated address once, in the first row's spelling", async () => {
        await seedChoice();
        setAttendees([buildAttendee("Ann@Example.com"), buildAttendee(ANN)]);

        await sendNotice();

        expect(noticedEmails()).toEqual(["Ann@Example.com"]);
      });

      it("sends nothing and writes nothing when everyone was already notified", async () => {
        await seedChoice({ notifiedAttendeeEmails: [ANN, BOB] });
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);

        await expect(sendNotice()).resolves.toBeUndefined();

        expect(noticeMock).not.toHaveBeenCalled();
        const choice = await storedChoice();
        expect(choice?.notifiedAttendeeEmails).toEqual([ANN, BOB]);
        expect(choice?.attendeesNotifiedAt).toBeNull();
      });

      it("sends nothing and writes nothing when the booking has no attendees", async () => {
        await seedChoice();
        setAttendees([]);

        await expect(sendNotice()).resolves.toBeUndefined();

        expect(noticeMock).not.toHaveBeenCalled();
        const choice = await storedChoice();
        expect(choice?.notifiedAttendeeEmails).toEqual([]);
        expect(choice?.attendeesNotifiedAt).toBeNull();
      });
    });

    describe("recording", () => {
      it("stores the addresses as written on the attendee rows and the time", async () => {
        await seedChoice({ notifiedAttendeeEmails: [CY] });
        setAttendees([buildAttendee("Ann@Example.com"), buildAttendee(BOB)]);

        await sendNotice();

        const choice = await storedChoice();
        expect(choice?.notifiedAttendeeEmails).toEqual([CY, "Ann@Example.com", BOB]);
        expect(choice?.attendeesNotifiedAt).toEqual(NOW);
      });

      it("sends nothing on a second run", async () => {
        await seedChoice();
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);
        await sendNotice();
        vi.setSystemTime(new Date(NOW.getTime() + 60 * 60 * 1000));
        noticeMock.mockClear();

        await sendNotice();

        expect(noticeMock).not.toHaveBeenCalled();
        expect((await storedChoice())?.attendeesNotifiedAt).toEqual(NOW);
      });

      it("emails only an attendee added after the first run", async () => {
        await seedChoice();
        setAttendees([buildAttendee(ANN), buildAttendee(BOB)]);
        await sendNotice();
        setAttendees([buildAttendee(ANN), buildAttendee(BOB), buildAttendee(CY)]);
        noticeMock.mockClear();

        await sendNotice();

        expect(noticedEmails()).toEqual([CY]);
        expect((await storedChoice())?.notifiedAttendeeEmails).toEqual([ANN, BOB, CY]);
      });

      it("does not email again after the notetaker is turned off and on", async () => {
        await seedChoice();
        setAttendees([buildAttendee(ANN)]);
        await sendNotice();
        await repositories.bookingNotetakerRepository.disable(BOOKING_ID);
        await seedChoice();
        noticeMock.mockClear();

        await sendNotice();

        expect(noticeMock).not.toHaveBeenCalled();
      });
    });

    describe("content", () => {
      beforeEach(async () => {
        await seedChoice();
      });

      it("uses each attendee's locale and time zone and falls back to English", async () => {
        setAttendees([
          buildAttendee(ANN, { locale: "de", timeZone: "Europe/Berlin" }),
          buildAttendee(BOB, { locale: null, timeZone: "America/New_York" }),
        ]);

        await sendNotice();

        expect(getTranslation).toHaveBeenCalledWith("de", "common");
        expect(getTranslation).toHaveBeenCalledWith("en", "common");
        const [first, second] = noticeMock.mock.calls.map(([input]) => input);
        expect(first.locale).toBe("de");
        expect(first.timeZone).toBe("Europe/Berlin");
        expect(first.t).toBe(translatorFor("de"));
        expect(second.locale).toBe("en");
        expect(second.timeZone).toBe("America/New_York");
        expect(second.t).toBe(translatorFor("en"));
      });

      it("passes the meeting, the host and the recipient", async () => {
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        const input = noticeMock.mock.calls[0][0];
        expect(input.bookingTitle).toBe("Planning call");
        expect(input.bookingStartTime).toEqual(new Date("2026-10-12T10:00:00.000Z"));
        expect(input.hostName).toBe("Organizer");
        expect(input.isPending).toBe(false);
        expect(input.to).toEqual({ email: ANN, name: "Guest Person" });
        expect(Object.keys(input).sort()).toEqual(NOTICE_INPUT_FIELDS);
      });

      it("falls back to the app name when the booking has no organizer", async () => {
        repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        expect(noticeMock.mock.calls[0][0].hostName).toBe(APP_NAME);
      });

      it.each(["PENDING", "AWAITING_HOST"] as const)("marks a %s booking as pending", async (status) => {
        repositories.store.addBooking(buildBooking({ status }));
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        expect(noticeMock.mock.calls[0][0].isPending).toBe(true);
      });

      it.each(["", "   "])("passes a null name for the attendee name %j", async (name) => {
        setAttendees([buildAttendee(ANN, { name })]);

        await sendNotice();

        expect(noticeMock.mock.calls[0][0].to.name).toBeNull();
      });

      it("carries no link", async () => {
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        // JSON.stringify drops the translator function, which is not part of the data under test.
        const sent = JSON.stringify(noticeMock.mock.calls);
        for (const fragment of ["http", BOOKING_UID, "/notetaker", WEBAPP_URL]) {
          expect(sent).not.toContain(fragment);
        }
      });

      it("is sent although standard emails are disabled for the booking", async () => {
        repositories.store.addBooking(
          buildBooking({ metadata: { disableStandardEmails: { all: { attendee: true, host: true } } } })
        );
        setAttendees([buildAttendee(ANN)]);

        await sendNotice();

        expect(noticedEmails()).toEqual([ANN]);
      });

      it("ignores the session id", async () => {
        setAttendees([buildAttendee(ANN)]);

        await sendNotice(BOOKING_ID, "missing-session");

        expect(noticedEmails()).toEqual([ANN]);
      });
    });

    describe("skipped targets", () => {
      async function expectSkipped(): Promise<void> {
        expect(noticeMock).not.toHaveBeenCalled();
        expect(loggerWasCalled()).toBe(true);
        const choice = await storedChoice();
        if (choice) {
          expect(choice.notifiedAttendeeEmails).toEqual([]);
          expect(choice.attendeesNotifiedAt).toBeNull();
        }
      }

      it("resolves without sending for an unknown booking", async () => {
        await expect(sendNotice(999)).resolves.toBeUndefined();

        await expectSkipped();
      });

      it("resolves without sending for a booking with no choice", async () => {
        setAttendees([buildAttendee(ANN)]);

        await expect(sendNotice()).resolves.toBeUndefined();

        await expectSkipped();
      });

      it("resolves without sending when the choice is off", async () => {
        await seedChoice({ enabled: false });
        setAttendees([buildAttendee(ANN)]);

        await expect(sendNotice()).resolves.toBeUndefined();

        await expectSkipped();
      });

      it.each([
        "CANCELLED",
        "REJECTED",
      ] as const)("resolves without sending for a %s booking", async (status) => {
        repositories.store.addBooking(buildBooking({ status }));
        await seedChoice();
        setAttendees([buildAttendee(ANN)]);

        await expect(sendNotice()).resolves.toBeUndefined();

        await expectSkipped();
      });
    });

    describe("failures", () => {
      beforeEach(async () => {
        await seedChoice();
        setAttendees([buildAttendee(ANN), buildAttendee(BOB), buildAttendee(CY)]);
      });

      it("emails everyone, records the successes and rejects naming the failures", async () => {
        failFor(BOB);

        const promise = sendNotice();

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
        await expect(promise).rejects.toThrow(String(BOOKING_ID));
        await expect(promise).rejects.toThrow("1 of 3");
        expect(noticeMock).toHaveBeenCalledTimes(3);
        const choice = await storedChoice();
        expect(choice?.notifiedAttendeeEmails).toEqual([ANN, CY]);
        expect(choice?.attendeesNotifiedAt).toEqual(NOW);
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      it("emails only the failed attendee on the retry", async () => {
        failFor(BOB);
        await expect(sendNotice()).rejects.toBeInstanceOf(ErrorWithCode);
        noticeMock.mockReset();
        noticeMock.mockResolvedValue(undefined);

        await sendNotice();

        expect(noticedEmails()).toEqual([BOB]);
        expect((await storedChoice())?.notifiedAttendeeEmails).toEqual([ANN, CY, BOB]);
      });

      it("records nothing when every send fails", async () => {
        noticeMock.mockRejectedValue(new Error("render failed"));

        await expect(sendNotice()).rejects.toBeInstanceOf(ErrorWithCode);

        const choice = await storedChoice();
        expect(choice?.notifiedAttendeeEmails).toEqual([]);
        expect(choice?.attendeesNotifiedAt).toBeNull();
      });

      it("keeps attendee and meeting details out of logs and errors", async () => {
        repositories.store.addBooking(
          buildBooking({
            title: "SECRET-MEETING-TITLE",
            organizer: {
              id: ORGANIZER_ID,
              name: "SECRET-HOST-NAME",
              email: "secret-host@example.org",
              locale: "en",
            },
          })
        );
        setAttendees([
          buildAttendee(ANN, { name: "SECRET-NAME-ANN" }),
          buildAttendee(BOB, { name: "SECRET-NAME-BOB" }),
          buildAttendee(CY, { name: "SECRET-NAME-CY" }),
        ]);
        failFor(BOB);

        const error = await sendNotice().then(
          () => null,
          (caught: unknown) => caught
        );
        repositories.store.addBooking(buildBooking({ title: "SECRET-MEETING-TITLE", status: "CANCELLED" }));
        await sendNotice();

        if (!(error instanceof Error)) throw new Error("Expected the partial failure to reject");
        const text = `${loggedText()}${error.message}`;
        for (const secret of [
          ANN,
          BOB,
          CY,
          "SECRET-NAME-ANN",
          "SECRET-NAME-BOB",
          "SECRET-NAME-CY",
          "SECRET-MEETING-TITLE",
          "SECRET-HOST-NAME",
          "secret-host@example.org",
        ]) {
          expect(text).not.toContain(secret);
        }
      });
    });
  });

  describe("ADMIT_PROMPT", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function seedWaitingSession(): Promise<string> {
      return seedSession({ status: "WAITING_TO_BE_ADMITTED" });
    }

    function pushedTo(endpointTag: string): Parameters<typeof sendNotification>[0] {
      const call = pushMock.mock.calls.find(([arg]) => arg.subscription.endpoint.endsWith(endpointTag));
      if (!call) throw new Error(`No push was sent for ${endpointTag}`);
      return call[0];
    }

    describe("recipients", () => {
      it("emails each distinct host who enabled the notetaker once and nobody else", async () => {
        userLookup.users = [buildUser(1), buildUser(2), buildUser(3)];
        await seedEnabled(1);
        await seedEnabled(2);
        await seedEnabled(1);
        await repositories.activityRepository.create({
          bookingId: BOOKING_ID,
          sessionId: null,
          action: "DISABLED",
          actorType: "USER",
          actorUserId: THIRD_USER_ID,
          actorName: null,
          detail: null,
        });
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(admitMock).toHaveBeenCalledTimes(2);
        expect(admitMock.mock.calls.map(([input]) => input.to.email).sort()).toEqual([
          "user1@example.com",
          "user2@example.com",
        ]);
        expect(sendMock).not.toHaveBeenCalled();
        expect(noticeMock).not.toHaveBeenCalled();
        expect(failedMock).not.toHaveBeenCalled();
      });

      it("sends an inherited choice to the organizer", async () => {
        userLookup.users = [buildUser(ORGANIZER_ID), buildUser(SECOND_HOST_ID)];
        await seedEnabled(null);
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(admitMock.mock.calls[0][0].to.email).toBe("user1@example.com");
        expect(userLookup.calls).toEqual([[ORGANIZER_ID]]);
      });

      it("sends nothing and logs when an inherited choice has no organizer", async () => {
        repositories.store.removeBooking(BOOKING_ID);
        repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));
        userLookup.users = [buildUser(ORGANIZER_ID)];
        await seedEnabled(null);
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
      });

      it("skips a user the lookup does not return", async () => {
        const subscriptionLookup = vi.spyOn(
          repositories.bookingNotetakerRepository,
          "findWebPushSubscriptionsByUserIds"
        );
        userLookup.users = [buildUser(1)];
        await seedEnabled(1);
        await seedEnabled(2);
        setSubscription(1, storedSubscription("1"));
        setSubscription(2, storedSubscription("2"));
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(admitMock.mock.calls[0][0].to.email).toBe("user1@example.com");
        expect(subscriptionLookup).toHaveBeenCalledWith([1]);
        expect(pushMock).toHaveBeenCalledTimes(1);
      });

      it("uses the recipient locale and time zone and falls back to English", async () => {
        userLookup.users = [
          buildUser(1, { locale: "de", timeZone: "Europe/Berlin" }),
          buildUser(2, { locale: null, timeZone: "America/New_York" }),
        ];
        await seedEnabled(1);
        await seedEnabled(2);
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(getTranslation).toHaveBeenCalledWith("de", "common");
        expect(getTranslation).toHaveBeenCalledWith("en", "common");
        const [first, second] = admitMock.mock.calls.map(([input]) => input);
        expect(first.locale).toBe("de");
        expect(first.timeZone).toBe("Europe/Berlin");
        expect(first.t).toBe(translatorFor("de"));
        expect(second.locale).toBe("en");
        expect(second.timeZone).toBe("America/New_York");
        expect(second.t).toBe(translatorFor("en"));
      });
    });

    describe("email content", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      it("passes the meeting, the recipient and the notetaker page link", async () => {
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        const input = admitMock.mock.calls[0][0];
        expect(input.bookingTitle).toBe("Planning call");
        expect(input.bookingStartTime).toEqual(new Date("2026-10-12T10:00:00.000Z"));
        expect(input.notetakerUrl).toBe(NOTETAKER_URL);
        expect(input.to).toEqual({ email: "user1@example.com", name: "User 1" });
        expect(Object.keys(input).sort()).toEqual(ADMIT_INPUT_FIELDS);
      });

      it("never passes passage or summary text to the email, the push or the logger", async () => {
        const sessionId = await seedWaitingSession();
        const transcriptId = await seedTranscript(sessionId);
        await seedSummary(transcriptId, "READY");
        setSubscription(1, storedSubscription("1"));

        await sendAdmit(sessionId);

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(pushMock).toHaveBeenCalledTimes(1);
        // JSON.stringify drops the translator function, which is not part of the data under test.
        const sent = JSON.stringify(admitMock.mock.calls);
        const pushed = JSON.stringify(pushMock.mock.calls);
        for (const secret of SECRETS) {
          expect(sent).not.toContain(secret);
          expect(pushed).not.toContain(secret);
          expect(loggedText()).not.toContain(secret);
        }
      });
    });

    describe("web push", () => {
      it("sends one push per host with the parsed subscription and the admit text", async () => {
        userLookup.users = [buildUser(1, { locale: "de" }), buildUser(2, { locale: "en" })];
        await seedEnabled(1);
        await seedEnabled(2);
        setSubscription(1, storedSubscription("1"));
        setSubscription(2, storedSubscription("2"));
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(pushMock).toHaveBeenCalledTimes(2);
        const arg = pushedTo("SECRET-ENDPOINT-1");
        expect(arg.subscription).toStrictEqual(buildSubscription("1"));
        expect(arg.title).toBe("PUSH-TITLE[de]");
        expect(arg.body).toBe("PUSH-BODY[de] Planning call");
        expect(arg.url).toBe(NOTETAKER_URL);
        expect(arg.type).toBe("NOTETAKER_ADMIT_PROMPT");
        expect(arg.requireInteraction).toBe(true);
        expect(Object.keys(arg).sort()).toEqual(PUSH_FIELDS);
        expect(pushedTo("SECRET-ENDPOINT-2").title).toBe("PUSH-TITLE[en]");
        expect(NOTETAKER_ADMIT_PROMPT_PUSH_TYPE).toBe("NOTETAKER_ADMIT_PROMPT");
      });

      it("puts the meeting title into the push body unescaped", async () => {
        repositories.store.addBooking(buildBooking({ title: "Q&A / <Planning>" }));
        await seedHosts(1);
        setSubscription(1, storedSubscription("1"));
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(pushMock.mock.calls[0][0].body).toBe("PUSH-BODY[en] Q&A / <Planning>");
      });

      it("uses only the most recent subscription of a host", async () => {
        await seedHosts(1);
        setSubscription(1, storedSubscription("older"), storedSubscription("newer"));
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(pushMock).toHaveBeenCalledTimes(1);
        expect(pushMock.mock.calls[0][0].subscription.endpoint).toBe(buildSubscription("newer").endpoint);
      });

      it("emails a host without a subscription and sends no push", async () => {
        await seedHosts(1);
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(pushMock).not.toHaveBeenCalled();
      });

      it.each([
        { name: "a stored string that is not JSON", stored: "not-json-SECRET-SUB" },
        { name: "a stored JSON null", stored: "null" },
        {
          name: "a subscription without keys",
          stored: JSON.stringify({ endpoint: "https://push.example.com/SECRET-SUB" }),
        },
        {
          name: "a subscription whose endpoint is not a URL",
          stored: JSON.stringify({ endpoint: "SECRET-SUB", keys: { auth: "a", p256dh: "b" } }),
        },
      ])("skips $name with a warning and still emails", async ({ stored }) => {
        await seedHosts(1);
        setSubscription(1, stored);
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(pushMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "Notetaker admit prompt push skipped: invalid subscription",
          {
            bookingId: BOOKING_ID,
            sessionId,
            userId: 1,
          }
        );
        expect(loggedText()).not.toContain("SECRET-SUB");
        expect(loggedText()).not.toContain("not-json");
      });

      it("still pushes to the valid host when another host's subscription is invalid", async () => {
        await seedHosts(1, 2);
        setSubscription(1, "not-json-SECRET-SUB");
        setSubscription(2, storedSubscription("2"));
        const sessionId = await seedWaitingSession();

        await sendAdmit(sessionId);

        expect(pushMock).toHaveBeenCalledTimes(1);
        expect(pushMock.mock.calls[0][0].subscription).toStrictEqual(buildSubscription("2"));
        expect(admitMock).toHaveBeenCalledTimes(2);
      });

      it("resolves when the subscription lookup fails", async () => {
        vi.spyOn(
          repositories.bookingNotetakerRepository,
          "findWebPushSubscriptionsByUserIds"
        ).mockRejectedValue(new Error("db down"));
        await seedHosts(1);
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).toHaveBeenCalledTimes(1);
        expect(pushMock).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
      });

      it("resolves when a push send rejects and still pushes to the next host", async () => {
        await seedHosts(1, 2);
        setSubscription(1, storedSubscription("1"));
        setSubscription(2, storedSubscription("2"));
        pushMock.mockRejectedValueOnce(new Error("SECRET-PUSH-ERROR"));
        const sessionId = await seedWaitingSession();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(pushMock).toHaveBeenCalledTimes(2);
        expect(loggedText()).not.toContain("SECRET-PUSH-ERROR");
      });
    });

    describe("skipped targets", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      it("resolves without sending or looking up users for an unknown booking", async () => {
        await expect(sendAdmit("missing", 999)).resolves.toBeUndefined();

        expect(admitMock).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
      });

      it.each([
        {
          name: "a null session id",
          arrange: async (): Promise<string | null> => null,
        },
        {
          name: "an unknown session id",
          arrange: async (): Promise<string | null> => "missing",
        },
        {
          name: "a session of another booking",
          arrange: async (): Promise<string | null> => {
            repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: "booking-uid-2" }));
            return seedSession({ bookingId: OTHER_BOOKING_ID, status: "WAITING_TO_BE_ADMITTED" });
          },
        },
      ])("resolves without sending and logs for $name", async ({ arrange }) => {
        const sessionId = await arrange();

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
        expect(loggerWasCalled()).toBe(true);
      });

      it.each([
        "SCHEDULED",
        "TRANSCRIBING",
        "PROCESSING",
        "READY",
        "ENDED_EARLY",
        "FAILED",
      ] as const)("skips a %s session as stale", async (status) => {
        const sessionId = await seedSession({ status });
        setSubscription(1, storedSubscription("1"));

        await expect(sendAdmit(sessionId)).resolves.toBeUndefined();

        expect(admitMock).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
        expect(logger.info).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ bookingId: BOOKING_ID, sessionId, status })
        );
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe("failures", () => {
      it("keeps emailing and pushing the other host when one email fails, then rejects", async () => {
        await seedHosts(1, 2);
        setSubscription(1, storedSubscription("1"));
        setSubscription(2, storedSubscription("2"));
        const sessionId = await seedWaitingSession();
        admitMock.mockRejectedValueOnce(new Error("render failed"));

        const promise = sendAdmit(sessionId);

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
        await expect(promise).rejects.toThrow("ADMIT_PROMPT");
        await expect(promise).rejects.toThrow(String(BOOKING_ID));
        await expect(promise).rejects.toThrow(sessionId);
        await expect(promise).rejects.toThrow("1 of 2");
        expect(admitMock).toHaveBeenCalledTimes(2);
        expect(pushMock).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      it("keeps host, meeting and subscription details out of logs and errors", async () => {
        repositories.store.addBooking(buildBooking({ title: "SECRET-MEETING-TITLE" }));
        userLookup.users = [
          buildUser(1, { name: "SECRET-NAME-1", email: "secret1@example.org" }),
          buildUser(2, { name: "SECRET-NAME-2", email: "secret2@example.org" }),
        ];
        await seedEnabled(1);
        await seedEnabled(2);
        setSubscription(1, storedSubscription("1"));
        setSubscription(2, "not-json-SECRET-SUB");
        admitMock.mockImplementation(async (input) => {
          if (input.to.email === "secret1@example.org") throw new Error("render failed");
        });
        const sessionId = await seedWaitingSession();

        const error = await sendAdmit(sessionId).then(
          () => null,
          (caught: unknown) => caught
        );

        if (!(error instanceof Error)) throw new Error("Expected the partial failure to reject");
        const text = `${loggedText()}${error.message}`;
        for (const secret of [
          "SECRET-NAME-1",
          "SECRET-NAME-2",
          "secret1@example.org",
          "secret2@example.org",
          "SECRET-MEETING-TITLE",
          "SECRET-ENDPOINT",
          "SECRET-AUTH",
          "SECRET-P256DH",
          "SECRET-SUB",
        ]) {
          expect(text).not.toContain(secret);
        }
      });
    });
  });

  describe("FAILED", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function seedFailedSession(
      outcomeReason: NotetakerOutcomeReasonDto | null = "NOT_ADMITTED"
    ): Promise<string> {
      return seedSession({ status: "FAILED", outcomeReason });
    }

    describe("recipients", () => {
      it("emails each distinct enabling host once and nobody else", async () => {
        userLookup.users = [buildUser(1), buildUser(2), buildUser(3)];
        await seedEnabled(1);
        await seedEnabled(2);
        await seedEnabled(1);
        await repositories.activityRepository.create({
          bookingId: BOOKING_ID,
          sessionId: null,
          action: "DISABLED",
          actorType: "USER",
          actorUserId: THIRD_USER_ID,
          actorName: null,
          detail: null,
        });
        const sessionId = await seedFailedSession();

        await sendFailedNotice(sessionId);

        expect(failedMock).toHaveBeenCalledTimes(2);
        expect(failedMock.mock.calls.map(([input]) => input.to.email).sort()).toEqual([
          "user1@example.com",
          "user2@example.com",
        ]);
        expect(sendMock).not.toHaveBeenCalled();
        expect(noticeMock).not.toHaveBeenCalled();
        expect(admitMock).not.toHaveBeenCalled();
      });

      it("sends an inherited choice to the organizer", async () => {
        userLookup.users = [buildUser(ORGANIZER_ID), buildUser(SECOND_HOST_ID)];
        await seedEnabled(null);
        const sessionId = await seedFailedSession();

        await sendFailedNotice(sessionId);

        expect(failedMock).toHaveBeenCalledTimes(1);
        expect(failedMock.mock.calls[0][0].to.email).toBe("user1@example.com");
        expect(userLookup.calls).toEqual([[ORGANIZER_ID]]);
      });

      it("uses the recipient locale and time zone and falls back to English", async () => {
        userLookup.users = [
          buildUser(1, { locale: "de", timeZone: "Europe/Berlin" }),
          buildUser(2, { locale: null, timeZone: "America/New_York" }),
        ];
        await seedEnabled(1);
        await seedEnabled(2);
        const sessionId = await seedFailedSession();

        await sendFailedNotice(sessionId);

        expect(getTranslation).toHaveBeenCalledWith("de", "common");
        expect(getTranslation).toHaveBeenCalledWith("en", "common");
        const [first, second] = failedMock.mock.calls.map(([input]) => input);
        expect(first.locale).toBe("de");
        expect(first.timeZone).toBe("Europe/Berlin");
        expect(first.t).toBe(translatorFor("de"));
        expect(second.locale).toBe("en");
        expect(second.timeZone).toBe("America/New_York");
        expect(second.t).toBe(translatorFor("en"));
      });

      it("sends no web push and never reads subscriptions", async () => {
        const subscriptionLookup = vi.spyOn(
          repositories.bookingNotetakerRepository,
          "findWebPushSubscriptionsByUserIds"
        );
        await seedHosts(1);
        setSubscription(1, storedSubscription("1"));
        const sessionId = await seedFailedSession();

        await sendFailedNotice(sessionId);

        expect(failedMock).toHaveBeenCalledTimes(1);
        expect(subscriptionLookup).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
        expect(admitMock).not.toHaveBeenCalled();
      });
    });

    describe("content", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      it("passes the meeting, the recipient and the notetaker page link", async () => {
        const sessionId = await seedFailedSession();

        await sendFailedNotice(sessionId);

        const input = failedMock.mock.calls[0][0];
        expect(input.bookingTitle).toBe("Planning call");
        expect(input.bookingStartTime).toEqual(new Date("2026-10-12T10:00:00.000Z"));
        expect(input.notetakerUrl).toBe(NOTETAKER_URL);
        expect(input.to).toEqual({ email: "user1@example.com", name: "User 1" });
        expect(Object.keys(input).sort()).toEqual(FAILED_INPUT_FIELDS);
      });

      it.each(OUTCOME_REASONS)("passes the outcome reason %s through", async (outcomeReason) => {
        const sessionId = await seedFailedSession(outcomeReason);

        await sendFailedNotice(sessionId);

        expect(failedMock.mock.calls[0][0].outcomeReason).toBe(outcomeReason);
      });

      it("reports a missing outcome reason as INTERRUPTED and logs it", async () => {
        const sessionId = await seedFailedSession(null);

        await sendFailedNotice(sessionId);

        expect(failedMock.mock.calls[0][0].outcomeReason).toBe("INTERRUPTED");
        expect(logger.warn).toHaveBeenCalledWith("Notetaker failed session has no outcome reason", {
          bookingId: BOOKING_ID,
          sessionId,
        });
      });

      it("never passes passage or summary text, an error code or a provider message", async () => {
        const sessionId = await seedFailedSession();
        const transcriptId = await seedTranscript(sessionId);
        await seedSummary(transcriptId, "READY");

        await sendFailedNotice(sessionId);

        expect(Object.keys(failedMock.mock.calls[0][0]).sort()).toEqual(FAILED_INPUT_FIELDS);
        // JSON.stringify drops the translator function, which is not part of the data under test.
        const sent = JSON.stringify(failedMock.mock.calls);
        for (const secret of SECRETS) {
          expect(sent).not.toContain(secret);
          expect(loggedText()).not.toContain(secret);
        }
      });
    });

    describe("canEnableAgain", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      async function sentCanEnableAgain(): Promise<boolean> {
        const sessionId = await seedFailedSession();
        await sendFailedNotice(sessionId);
        return failedMock.mock.calls[0][0].canEnableAgain;
      }

      it("is true before the booking ends when rejoin is not blocked", async () => {
        await seedChoice();

        expect(await sentCanEnableAgain()).toBe(true);
      });

      it("is true when the booking has no choice row", async () => {
        expect(await sentCanEnableAgain()).toBe(true);
      });

      it("is false at the booking end", async () => {
        vi.setSystemTime(BOOKING_END);

        expect(await sentCanEnableAgain()).toBe(false);
      });

      it("is false after the booking end", async () => {
        vi.setSystemTime(new Date(BOOKING_END.getTime() + 1));

        expect(await sentCanEnableAgain()).toBe(false);
      });

      it("is true one millisecond before the booking end", async () => {
        vi.setSystemTime(new Date(BOOKING_END.getTime() - 1));

        expect(await sentCanEnableAgain()).toBe(true);
      });

      it("is false when rejoin is blocked", async () => {
        await seedChoice();
        await repositories.bookingNotetakerRepository.setRejoinBlocked(BOOKING_ID, true);

        expect(await sentCanEnableAgain()).toBe(false);
      });

      it("does not consult the booking status", async () => {
        repositories.store.addBooking(buildBooking({ status: "CANCELLED" }));

        expect(await sentCanEnableAgain()).toBe(true);
      });
    });

    describe("skipped targets", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      it("resolves without sending or looking up users for an unknown booking", async () => {
        await expect(sendFailedNotice("missing", 999)).resolves.toBeUndefined();

        expect(failedMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
      });

      it.each([
        {
          name: "a null session id",
          arrange: async (): Promise<string | null> => null,
        },
        {
          name: "an unknown session id",
          arrange: async (): Promise<string | null> => "missing",
        },
        {
          name: "a session of another booking",
          arrange: async (): Promise<string | null> => {
            repositories.store.addBooking(buildBooking({ id: OTHER_BOOKING_ID, uid: "booking-uid-2" }));
            return seedSession({
              bookingId: OTHER_BOOKING_ID,
              status: "FAILED",
              outcomeReason: "NOT_ADMITTED",
            });
          },
        },
      ])("resolves without sending and logs for $name", async ({ arrange }) => {
        const sessionId = await arrange();

        await expect(sendFailedNotice(sessionId)).resolves.toBeUndefined();

        expect(failedMock).not.toHaveBeenCalled();
        expect(loggerWasCalled()).toBe(true);
      });

      it.each([
        "SCHEDULED",
        "WAITING_TO_BE_ADMITTED",
        "TRANSCRIBING",
        "PROCESSING",
        "READY",
        "ENDED_EARLY",
      ] as const)("skips a %s session", async (status) => {
        const sessionId = await seedSession({ status });

        await expect(sendFailedNotice(sessionId)).resolves.toBeUndefined();

        expect(failedMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
      });

      it("sends nothing and logs when there is no recipient", async () => {
        repositories.store.removeBooking(BOOKING_ID);
        repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));
        const sessionId = await seedFailedSession();

        await expect(sendFailedNotice(sessionId)).resolves.toBeUndefined();

        expect(failedMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe("failures", () => {
      it("keeps emailing the other recipient when one send fails, then rejects", async () => {
        await seedHosts(1, 2);
        const sessionId = await seedFailedSession();
        failedMock.mockRejectedValueOnce(new Error("render failed"));

        const promise = sendFailedNotice(sessionId);

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
        await expect(promise).rejects.toThrow("FAILED");
        await expect(promise).rejects.toThrow(String(BOOKING_ID));
        await expect(promise).rejects.toThrow(sessionId);
        await expect(promise).rejects.toThrow("1 of 2");
        expect(failedMock).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      it("keeps host and meeting details out of logs and errors", async () => {
        repositories.store.addBooking(buildBooking({ title: "SECRET-MEETING-TITLE" }));
        userLookup.users = [
          buildUser(1, { name: "SECRET-NAME-1", email: "secret1@example.org" }),
          buildUser(2, { name: "SECRET-NAME-2", email: "secret2@example.org" }),
        ];
        await seedEnabled(1);
        await seedEnabled(2);
        failedMock.mockImplementation(async (input) => {
          if (input.to.email === "secret1@example.org") throw new Error("render failed");
        });
        const sessionId = await seedFailedSession();

        const error = await sendFailedNotice(sessionId).then(
          () => null,
          (caught: unknown) => caught
        );

        if (!(error instanceof Error)) throw new Error("Expected the partial failure to reject");
        const text = `${loggedText()}${error.message}`;
        for (const secret of [
          "SECRET-NAME-1",
          "SECRET-NAME-2",
          "secret1@example.org",
          "secret2@example.org",
          "SECRET-MEETING-TITLE",
        ]) {
          expect(text).not.toContain(secret);
        }
      });
    });
  });

  describe("TURNED_OFF", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function sendTurnedOff(bookingId: number = BOOKING_ID): Promise<void> {
      return service.send({ kind: "TURNED_OFF", bookingId, sessionId: null });
    }

    describe("recipients", () => {
      it("emails each distinct enabling host once and nobody else", async () => {
        userLookup.users = [buildUser(1), buildUser(2), buildUser(3)];
        await seedEnabled(1);
        await seedEnabled(2);
        await seedEnabled(1);
        await repositories.activityRepository.create({
          bookingId: BOOKING_ID,
          sessionId: null,
          action: "DISABLED",
          actorType: "USER",
          actorUserId: THIRD_USER_ID,
          actorName: null,
          detail: null,
        });
        await seedChoice({ enabled: false });

        await sendTurnedOff();

        expect(turnedOffMock).toHaveBeenCalledTimes(2);
        expect(turnedOffMock.mock.calls.map(([input]) => input.to.email).sort()).toEqual([
          "user1@example.com",
          "user2@example.com",
        ]);
        expect(sendMock).not.toHaveBeenCalled();
        expect(noticeMock).not.toHaveBeenCalled();
        expect(admitMock).not.toHaveBeenCalled();
        expect(failedMock).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();
      });

      it("sends an inherited choice to the organizer", async () => {
        userLookup.users = [buildUser(ORGANIZER_ID), buildUser(SECOND_HOST_ID)];
        await seedEnabled(null);
        await seedChoice({ enabled: false });

        await sendTurnedOff();

        expect(turnedOffMock).toHaveBeenCalledTimes(1);
        expect(turnedOffMock.mock.calls[0][0].to.email).toBe("user1@example.com");
        expect(userLookup.calls).toEqual([[ORGANIZER_ID]]);
      });

      it("sends nothing and logs when there is no recipient", async () => {
        repositories.store.removeBooking(BOOKING_ID);
        repositories.store.addBooking(buildBooking({ userId: null, organizer: null }));
        await seedChoice({ enabled: false });

        await expect(sendTurnedOff()).resolves.toBeUndefined();

        expect(turnedOffMock).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe("content", () => {
      it("passes the meeting, the recipient, the locale and the notetaker page link", async () => {
        userLookup.users = [buildUser(1, { locale: "de", timeZone: "Europe/Berlin" })];
        await seedEnabled(1);
        await seedChoice({ enabled: false });

        await sendTurnedOff();

        const input = turnedOffMock.mock.calls[0][0];
        expect(input.bookingTitle).toBe("Planning call");
        expect(input.bookingStartTime).toEqual(new Date("2026-10-12T10:00:00.000Z"));
        expect(input.timeZone).toBe("Europe/Berlin");
        expect(input.locale).toBe("de");
        expect(input.t).toBe(translatorFor("de"));
        expect(input.to).toEqual({ email: "user1@example.com", name: "User 1" });
        expect(input.notetakerUrl).toBe(NOTETAKER_URL);
        expect(Object.keys(input).sort()).toEqual(TURNED_OFF_INPUT_FIELDS);
        expect(getTranslation).toHaveBeenCalledWith("de", "common");
      });

      it("never passes passage or summary text to the email or the logger", async () => {
        await seedHosts(1);
        await seedChoice({ enabled: false });
        const sessionId = await seedReadySession();
        const transcriptId = await seedTranscript(sessionId);
        await seedSummary(transcriptId, "READY");

        await sendTurnedOff();

        expect(turnedOffMock).toHaveBeenCalledTimes(1);
        // JSON.stringify drops the translator function, which is not part of the data under test.
        const sent = JSON.stringify(turnedOffMock.mock.calls.map(([input]) => input));
        SECRETS.forEach((secret) => {
          expect(sent).not.toContain(secret);
          expect(loggedText()).not.toContain(secret);
        });
      });
    });

    describe("skipped targets", () => {
      beforeEach(async () => {
        await seedHosts(1);
      });

      it("resolves without sending or looking up users for an unknown booking", async () => {
        await seedChoice({ enabled: false });

        await expect(sendTurnedOff(999)).resolves.toBeUndefined();

        expect(turnedOffMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
        expect(logger.warn).toHaveBeenCalled();
      });

      it("resolves without sending when the booking has no choice", async () => {
        await expect(sendTurnedOff()).resolves.toBeUndefined();

        expect(turnedOffMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
        expect(logger.warn).toHaveBeenCalled();
      });

      it("skips a re-enabled choice as stale without a warning", async () => {
        await seedChoice({ enabled: true });

        await expect(sendTurnedOff()).resolves.toBeUndefined();

        expect(turnedOffMock).not.toHaveBeenCalled();
        expect(userLookup.calls).toEqual([]);
        expect(logger.info).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe("failures", () => {
      it("keeps emailing the other recipient when one send fails, then rejects", async () => {
        await seedHosts(1, 2);
        await seedChoice({ enabled: false });
        turnedOffMock.mockRejectedValueOnce(new Error("render failed"));

        const promise = sendTurnedOff();

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
        await expect(promise).rejects.toThrow("TURNED_OFF");
        await expect(promise).rejects.toThrow(String(BOOKING_ID));
        await expect(promise).rejects.toThrow("1 of 2");
        expect(turnedOffMock).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      describe("with identifying details in the data", () => {
        const SECRET_TEXTS = [
          "SECRET-NAME-1",
          "SECRET-NAME-2",
          "secret1@example.org",
          "secret2@example.org",
          "SECRET-MEETING-TITLE",
        ];

        beforeEach(() => {
          repositories.store.removeBooking(BOOKING_ID);
          repositories.store.addBooking(buildBooking({ title: "SECRET-MEETING-TITLE" }));
          userLookup.users = [
            buildUser(1, { name: "SECRET-NAME-1", email: "secret1@example.org" }),
            buildUser(2, { name: "SECRET-NAME-2", email: "secret2@example.org" }),
          ];
        });

        it("keeps host and meeting details out of logs and errors", async () => {
          await seedEnabled(1);
          await seedEnabled(2);
          await seedChoice({ enabled: false });
          turnedOffMock.mockImplementation(async (input) => {
            if (input.to.email === "secret1@example.org") throw new Error("render failed");
          });

          const error = await sendTurnedOff().then(
            () => null,
            (caught: unknown) => caught
          );

          if (!(error instanceof Error)) throw new Error("Expected the partial failure to reject");
          const text = `${loggedText()}${error.message}`;
          SECRET_TEXTS.forEach((secret) => {
            expect(text).not.toContain(secret);
          });
        });

        it("keeps them out of the logs on every skip path", async () => {
          await seedEnabled(1);
          await seedEnabled(2);

          await sendTurnedOff(999);
          await sendTurnedOff();
          await seedChoice({ enabled: true });
          await sendTurnedOff();

          expect(turnedOffMock).not.toHaveBeenCalled();
          expect(loggedText()).not.toContain("SECRET-");
          expect(loggedText()).not.toContain("example.org");
        });

        it("keeps them out of the logs when there is no recipient", async () => {
          repositories.store.removeBooking(BOOKING_ID);
          repositories.store.addBooking(
            buildBooking({ userId: null, organizer: null, title: "SECRET-MEETING-TITLE" })
          );
          await seedChoice({ enabled: false });

          await sendTurnedOff();

          expect(turnedOffMock).not.toHaveBeenCalled();
          expect(logger.warn).toHaveBeenCalled();
          SECRET_TEXTS.forEach((secret) => {
            expect(loggedText()).not.toContain(secret);
          });
        });
      });
    });
  });
});
