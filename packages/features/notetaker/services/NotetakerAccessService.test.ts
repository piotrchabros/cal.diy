import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerAccessService } from "./NotetakerAccessService";

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;
const CO_HOST_ID = 2;
const ATTENDEE_USER_ID = 3;
const TEAM_ADMIN_ID = 4;
const STRANGER_ID = 5;

const ORGANIZER_EMAIL = "organizer@example.com";
const CO_HOST_EMAIL = "cohost@example.com";
const ATTENDEE_EMAIL = "attendee@example.com";
const ATTENDEE_SECONDARY_EMAIL = "attendee.secondary@example.com";
const TEAM_ADMIN_EMAIL = "admin@example.com";
const STRANGER_EMAIL = "stranger@example.com";

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

describe("NotetakerAccessService", () => {
  let store: ReturnType<typeof createInMemoryNotetakerRepositories>["store"];
  let bookingNotetakerRepository: ReturnType<
    typeof createInMemoryNotetakerRepositories
  >["bookingNotetakerRepository"];
  let service: NotetakerAccessService;

  beforeEach(() => {
    const repositories = createInMemoryNotetakerRepositories();
    store = repositories.store;
    bookingNotetakerRepository = repositories.bookingNotetakerRepository;
    service = new NotetakerAccessService({ bookingNotetakerRepository });
  });

  function grant(): Promise<unknown> {
    return bookingNotetakerRepository.createSharingGrant({
      bookingId: BOOKING_ID,
      grantedByUserId: ORGANIZER_ID,
    });
  }

  describe("resolveViewerRole", () => {
    it("treats the organizer as HOST without a grant or verified emails", async () => {
      store.addBooking(buildBooking());

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(result.role).toBe("HOST");
      expect(result.booking.uid).toBe(BOOKING_UID);
      expect(result.booking.id).toBe(BOOKING_ID);
    });

    it("treats an event-type host who is an attendee as HOST without a grant", async () => {
      store.addBooking(
        buildBooking({
          attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
          eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
        })
      );

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      expect(result.role).toBe("HOST");
    });

    it("matches the host email against the attendee list case-insensitively", async () => {
      store.addBooking(
        buildBooking({
          attendeeEmails: ["CoHost@Example.COM"],
          eventTypeHosts: [{ userId: CO_HOST_ID, email: "  cohost@example.com " }],
        })
      );

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      expect(result.role).toBe("HOST");
    });

    it("rejects an event-type host who is not an attendee", async () => {
      store.addBooking(buildBooking({ eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }] }));

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects a non-attendee event-type host even when a grant exists", async () => {
      store.addBooking(buildBooking({ eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }] }));
      store.setVerifiedEmails(CO_HOST_ID, [CO_HOST_EMAIL]);
      await grant();

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects a team or organization admin with no relation to the booking, with or without a grant", async () => {
      // The service has no membership dependency, so an admin is simply a user
      // with no relation in the booking context.
      store.addBooking(buildBooking());
      store.setVerifiedEmails(TEAM_ADMIN_ID, [TEAM_ADMIN_EMAIL]);

      const withoutGrant = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: TEAM_ADMIN_ID });
      await expect(withoutGrant).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(withoutGrant).rejects.toMatchObject({ code: ErrorCode.Forbidden });

      await grant();

      const withGrant = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: TEAM_ADMIN_ID });
      await expect(withGrant).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(withGrant).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("treats an attendee matched by primary email as ATTENDEE once a grant exists", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      expect(result.role).toBe("ATTENDEE");
      expect(result.booking.uid).toBe(BOOKING_UID);
    });

    it("treats an attendee matched by a verified secondary email as ATTENDEE", async () => {
      store.addBooking(buildBooking({ attendeeEmails: [ATTENDEE_SECONDARY_EMAIL] }));
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL, ATTENDEE_SECONDARY_EMAIL]);
      await grant();

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      expect(result.role).toBe("ATTENDEE");
    });

    it("matches attendee emails that differ only in case", async () => {
      store.addBooking(buildBooking({ attendeeEmails: ["Attendee@Example.COM"] }));
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      expect(result.role).toBe("ATTENDEE");
    });

    it("rejects an attendee before any sharing grant exists", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects an attendee right after the grant is revoked", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const granted = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });
      expect(granted.role).toBe("ATTENDEE");

      await bookingNotetakerRepository.deleteSharingGrant(BOOKING_ID);

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });
      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects a user whose matching secondary email is unverified", async () => {
      store.addBooking(buildBooking({ attendeeEmails: [ATTENDEE_SECONDARY_EMAIL] }));
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects an unrelated signed-in user even when a grant exists", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(STRANGER_ID, [STRANGER_EMAIL]);
      await grant();

      const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: STRANGER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("throws NotFound for an unknown booking uid", async () => {
      const promise = service.resolveViewerRole({ bookingUid: "missing-uid", userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
    });

    it("handles a booking without organizer: unrelated user rejected, granted attendee still allowed", async () => {
      store.addBooking(buildBooking({ userId: null, organizer: null }));
      store.setVerifiedEmails(STRANGER_ID, [STRANGER_EMAIL]);
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const stranger = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: STRANGER_ID });
      await expect(stranger).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(stranger).rejects.toMatchObject({ code: ErrorCode.Forbidden });

      const attendee = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });
      expect(attendee.role).toBe("ATTENDEE");
    });
  });

  describe("assertHost", () => {
    it("resolves to the booking context for the organizer", async () => {
      store.addBooking(buildBooking());

      const booking = await service.assertHost({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      expect(booking.uid).toBe(BOOKING_UID);
    });

    it("resolves for an event-type host who is also an attendee", async () => {
      store.addBooking(
        buildBooking({
          attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
          eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
        })
      );

      const booking = await service.assertHost({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      expect(booking.uid).toBe(BOOKING_UID);
    });

    it("rejects a granted attendee", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
      await grant();

      const promise = service.assertHost({ bookingUid: BOOKING_UID, userId: ATTENDEE_USER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects an event-type host who is not an attendee", async () => {
      store.addBooking(buildBooking({ eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }] }));

      const promise = service.assertHost({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("rejects an unrelated user", async () => {
      store.addBooking(buildBooking());
      store.setVerifiedEmails(STRANGER_ID, [STRANGER_EMAIL]);

      const promise = service.assertHost({ bookingUid: BOOKING_UID, userId: STRANGER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    });

    it("throws NotFound for an unknown booking uid", async () => {
      const promise = service.assertHost({ bookingUid: "missing-uid", userId: ORGANIZER_ID });

      await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.NotFound });
    });
  });
});
