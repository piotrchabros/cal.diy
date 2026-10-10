import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE, NotetakerAccessService } from "./NotetakerAccessService";

const BOOKING_ID = 100;
const BOOKING_UID = "booking-uid-1";
const ORGANIZER_ID = 1;
const CO_HOST_ID = 2;
const ATTENDEE_USER_ID = 3;
const TEAM_ADMIN_ID = 4;
const STRANGER_ID = 5;
const COLLEAGUE_ID = 6;
const EVENT_TYPE_ID = 10;
const TEAM_ID = 20;
const ORGANIZATION_ID = 30;

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
    eventTypeId: EVENT_TYPE_ID,
    attendeeEmails: [ATTENDEE_EMAIL],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: "Organizer", email: ORGANIZER_EMAIL, locale: "en" },
    ...overrides,
  };
}

describe("NotetakerAccessService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let store: ReturnType<typeof createInMemoryNotetakerRepositories>["store"];
  let bookingNotetakerRepository: ReturnType<
    typeof createInMemoryNotetakerRepositories
  >["bookingNotetakerRepository"];
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let service: NotetakerAccessService;

  beforeEach(() => {
    repositories = createInMemoryNotetakerRepositories();
    store = repositories.store;
    bookingNotetakerRepository = repositories.bookingNotetakerRepository;
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    service = new NotetakerAccessService({
      bookingNotetakerRepository,
      sessionRepository: repositories.sessionRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
    });
  });

  async function addSession(
    options: { disclosed?: boolean; withTranscript?: boolean; dispatchedAt?: Date } = {}
  ): Promise<string> {
    const session = await repositories.sessionRepository.create({
      bookingId: BOOKING_ID,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      dispatchedAt: options.dispatchedAt ?? new Date("2026-10-12T09:55:00.000Z"),
      colleagueSharingDisclosed: options.disclosed ?? true,
    });
    if (options.withTranscript !== false) {
      await repositories.transcriptRepository.createIfMissing({
        sessionId: session.id,
        bookingId: BOOKING_ID,
      });
    }
    return session.id;
  }

  async function expectDenied(userId: number): Promise<void> {
    const promise = service.resolveViewerRole({ bookingUid: BOOKING_UID, userId });
    await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.Forbidden,
      message: NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE,
    });
  }

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

    it("rejects a team admin who is not a host while the mode is HOSTS_ONLY, with or without a grant", async () => {
      store.addBooking(buildBooking({ teamId: TEAM_ID }));
      store.setVerifiedEmails(TEAM_ADMIN_ID, [TEAM_ADMIN_EMAIL]);
      membershipLookup.addMember({ teamId: TEAM_ID, userId: TEAM_ADMIN_ID, email: TEAM_ADMIN_EMAIL });
      await addSession();

      await expectDenied(TEAM_ADMIN_ID);

      await grant();

      await expectDenied(TEAM_ADMIN_ID);
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

  describe("shared viewer", () => {
    describe("mode TEAM", () => {
      beforeEach(() => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "TEAM");
      });

      it("treats an accepted team member as SHARED_VIEWER without a grant", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        expect(result.role).toBe("SHARED_VIEWER");
        expect(result.booking.uid).toBe(BOOKING_UID);
      });

      it("rejects a member who was removed from the team", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();
        const before = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });
        expect(before.role).toBe("SHARED_VIEWER");

        membershipLookup.removeMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a member whose invitation is not accepted", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID, accepted: false });
        await addSession();

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a member of the organization who is not in the team", async () => {
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession();

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a listed person who is not a team member", async () => {
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession();

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects when the session was not disclosed", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession({ disclosed: false });

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects when no session has a transcript", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession({ withTranscript: false });

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects when the booking has no session", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects when the results were deleted", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        const sessionId = await addSession();
        await repositories.sessionRepository.update(sessionId, {
          resultsDeletedAt: new Date("2026-10-12T12:00:00.000Z"),
        });

        await expectDenied(COLLEAGUE_ID);
      });

      it("lets a later undisclosed transcript session hide an earlier disclosed one", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession({ dispatchedAt: new Date("2026-10-12T09:55:00.000Z") });
        await addSession({ disclosed: false, dispatchedAt: new Date("2026-10-12T10:10:00.000Z") });

        await expectDenied(COLLEAGUE_ID);
      });

      it("ignores a later undisclosed session that has no transcript", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession({ dispatchedAt: new Date("2026-10-12T09:55:00.000Z") });
        await addSession({
          disclosed: false,
          withTranscript: false,
          dispatchedAt: new Date("2026-10-12T10:10:00.000Z"),
        });

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        expect(result.role).toBe("SHARED_VIEWER");
      });

      it("keeps the organizer a HOST", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: ORGANIZER_ID });
        await addSession();

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

        expect(result.role).toBe("HOST");
      });

      it("keeps a granted attendee an ATTENDEE even when they are a team member", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: ATTENDEE_USER_ID });
        store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
        await addSession();
        await grant();

        const result = await service.resolveViewerRole({
          bookingUid: BOOKING_UID,
          userId: ATTENDEE_USER_ID,
        });

        expect(result.role).toBe("ATTENDEE");
      });

      it("treats an attendee without a grant who is a team member as SHARED_VIEWER", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: ATTENDEE_USER_ID });
        store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
        await addSession();

        const result = await service.resolveViewerRole({
          bookingUid: BOOKING_UID,
          userId: ATTENDEE_USER_ID,
        });

        expect(result.role).toBe("SHARED_VIEWER");
      });

      it("treats a team member as SHARED_VIEWER when a grant exists for the attendees", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();
        await grant();

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        expect(result.role).toBe("SHARED_VIEWER");
      });

      it("refuses a shared viewer in assertHost with the host-only message", async () => {
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();

        const promise = service.assertHost({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        await expect(promise).rejects.toBeInstanceOf(ErrorWithCode);
        await expect(promise).rejects.toMatchObject({
          code: ErrorCode.Forbidden,
          message: "Only a host of this booking can perform this action",
        });
      });
    });

    describe("mode SELECTED_PEOPLE", () => {
      it("treats a listed person accepted in the organization as SHARED_VIEWER", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession();

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        expect(result.role).toBe("SHARED_VIEWER");
      });

      it("checks the team when the event type has no organization", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: null }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID, STRANGER_ID]);
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();

        const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        expect(result.role).toBe("SHARED_VIEWER");
        await expectDenied(STRANGER_ID);
      });

      it("rejects a listed person who is only in the team when the event type has an organization", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a listed person who left the organization", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession();
        membershipLookup.removeMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a team member who is not on the list", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [STRANGER_ID]);
        membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession();

        await expectDenied(COLLEAGUE_ID);
      });

      it("rejects a listed person when the session was not disclosed", async () => {
        store.addBooking(buildBooking({ teamId: TEAM_ID, organizationId: ORGANIZATION_ID }));
        store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
        store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: COLLEAGUE_ID });
        await addSession({ disclosed: false });

        await expectDenied(COLLEAGUE_ID);
      });
    });

    it("rejects when the event type has no team, whatever the stored mode", async () => {
      store.addBooking(buildBooking());
      store.setSharingMode(EVENT_TYPE_ID, "TEAM");
      store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
      membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
      await addSession();

      await expectDenied(COLLEAGUE_ID);

      store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");

      await expectDenied(COLLEAGUE_ID);
    });

    it("rejects when the booking has no event type", async () => {
      store.addBooking(buildBooking({ eventTypeId: null, teamId: TEAM_ID }));
      membershipLookup.addMember({ teamId: TEAM_ID, userId: COLLEAGUE_ID });
      await addSession();

      await expectDenied(COLLEAGUE_ID);
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
