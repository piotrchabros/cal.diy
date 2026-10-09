import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";
import { NotetakerResultsService } from "./NotetakerResultsService";

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const OTHER_BOOKING_ID = 101;
const OTHER_BOOKING_UID = "booking-uid-2";
const ORGANIZER_ID = 1;
const ATTENDEE_USER_ID = 3;
const STRANGER_ID = 5;

const ORGANIZER_EMAIL = "organizer@example.com";
const ATTENDEE_EMAIL = "attendee@example.com";

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

describe("NotetakerResultsService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let service: NotetakerResultsService;

  beforeEach(() => {
    repositories = createInMemoryNotetakerRepositories();
    const { bookingNotetakerRepository, sessionRepository, transcriptRepository } = repositories;
    const accessService = new NotetakerAccessService({ bookingNotetakerRepository });
    service = new NotetakerResultsService({ accessService, sessionRepository, transcriptRepository });
    repositories.store.addBooking(buildBooking());
  });

  async function seedSessionWithTranscript(
    options: {
      bookingId?: number;
      dispatchedAt?: Date;
      withTranscript?: boolean;
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
});
