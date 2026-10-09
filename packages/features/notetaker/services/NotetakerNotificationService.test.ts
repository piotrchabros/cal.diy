import {
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerResultsReadyEmail,
} from "@calcom/emails/notetaker-email-service";
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
import { NotetakerNotificationService } from "./NotetakerNotificationService";

vi.mock("@calcom/emails/notetaker-email-service", () => ({
  sendNotetakerAttendeeNoticeEmail: vi.fn(),
  sendNotetakerResultsReadyEmail: vi.fn(),
}));
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

const NOW: Date = new Date("2026-10-10T08:00:00.000Z");
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";

const translators = new Map<string, TFunction>();

function translatorFor(locale: string): TFunction {
  const existing = translators.get(locale);
  if (existing) return existing;
  const instance = createInstance();
  instance.init({ lng: locale, resources: { [locale]: { common: {} } } });
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
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let userLookup: FakeUserLookup;
  let service: NotetakerNotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTranslation).mockImplementation(async (locale) => translatorFor(locale));
    sendMock.mockResolvedValue(undefined);
    noticeMock.mockResolvedValue(undefined);

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
    it.each([
      "ADMIT_PROMPT",
      "FAILED",
      "TURNED_OFF",
      "SHARED_WITH_ATTENDEES",
    ] as const)("rejects %s as having no handler", async (kind) => {
      const promise = service.send({ kind, bookingId: BOOKING_ID, sessionId: null });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.InternalServerError });
      await expect(promise).rejects.toThrow(kind);
      expect(sendMock).not.toHaveBeenCalled();
      expect(noticeMock).not.toHaveBeenCalled();
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
});
