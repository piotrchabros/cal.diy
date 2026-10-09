import { sendNotetakerResultsReadyEmail } from "@calcom/emails/notetaker-email-service";
import { getTranslation } from "@calcom/i18n/server";
import { WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { createInstance, type TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerNotificationService } from "./NotetakerNotificationService";

vi.mock("@calcom/emails/notetaker-email-service", () => ({
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
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let userLookup: FakeUserLookup;
  let service: NotetakerNotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTranslation).mockImplementation(async (locale) => translatorFor(locale));
    sendMock.mockResolvedValue(undefined);

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
      "ATTENDEE_NOTICE",
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
});
