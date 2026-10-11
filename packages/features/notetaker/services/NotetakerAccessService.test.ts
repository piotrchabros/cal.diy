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
const CHOSEN_TEAM_ID = 40;
const OTHER_TEAM_ID = 41;
const CHOSEN_TEAM_NAME = "Sales";

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

    describe("personal event type", () => {
      // The fake does not derive the effective team for a booking seed, so the seed states what the
      // repository would report: the chosen team, no organization, and the event type's owner.
      function addPersonalBooking(overrides: Partial<InMemoryBookingSeed> = {}): void {
        store.addBooking(
          buildBooking({
            teamId: CHOSEN_TEAM_ID,
            teamName: CHOSEN_TEAM_NAME,
            sharingOwnerUserId: ORGANIZER_ID,
            ...overrides,
          })
        );
      }

      describe("mode TEAM", () => {
        beforeEach(() => {
          store.setSharingMode(EVENT_TYPE_ID, "TEAM");
        });

        it("treats a member of the chosen team as SHARED_VIEWER while the owner is an accepted member", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

          expect(result.role).toBe("SHARED_VIEWER");
          expect(result.booking.uid).toBe(BOOKING_UID);
        });

        it("rejects a member of the chosen team once the owner is removed from it, and admits them again when the owner rejoins", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();
          const before = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });
          expect(before.role).toBe("SHARED_VIEWER");

          membershipLookup.removeMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });

          await expectDenied(COLLEAGUE_ID);

          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });

          const after = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });
          expect(after.role).toBe("SHARED_VIEWER");
        });

        it("rejects when the owner's membership of the chosen team is not accepted", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID, accepted: false });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects when the owner is a member of another team only", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects when the chosen team was deleted, whatever the stored mode and list", async () => {
          addPersonalBooking({ teamId: null, teamName: null, sharingOwnerUserId: null });
          store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);

          store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a member of another team of the owner who is not in the chosen team", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a member of the chosen team whose invitation is not accepted", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID, accepted: false });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a listed person who is not in the chosen team", async () => {
          addPersonalBooking();
          store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects when the session was not disclosed", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession({ disclosed: false });

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects when the results were deleted", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          const sessionId = await addSession();
          await repositories.sessionRepository.update(sessionId, {
            resultsDeletedAt: new Date("2026-10-12T12:00:00.000Z"),
          });

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects while the stored mode is HOSTS_ONLY", async () => {
          addPersonalBooking();
          store.setSharingMode(EVENT_TYPE_ID, "HOSTS_ONLY");
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });
      });

      describe("mode SELECTED_PEOPLE", () => {
        beforeEach(() => {
          store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");
          store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
        });

        it("treats a listed person accepted in the chosen team as SHARED_VIEWER while the owner is an accepted member", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

          expect(result.role).toBe("SHARED_VIEWER");
        });

        it("rejects a listed person who left the chosen team", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();
          membershipLookup.removeMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a listed person who is in another team of the owner only", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a member of the chosen team who is not on the list", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: STRANGER_ID });
          await addSession();

          await expectDenied(STRANGER_ID);
        });

        it("rejects a listed person once the owner left the chosen team", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession();
          membershipLookup.removeMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });

          await expectDenied(COLLEAGUE_ID);
        });

        it("rejects a listed person when the session was not disclosed", async () => {
          addPersonalBooking();
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          await addSession({ disclosed: false });

          await expectDenied(COLLEAGUE_ID);
        });
      });

      describe("owner no longer an accepted member of the chosen team", () => {
        beforeEach(async () => {
          addPersonalBooking({
            attendeeEmails: [ATTENDEE_EMAIL, CO_HOST_EMAIL],
            eventTypeHosts: [{ userId: CO_HOST_ID, email: CO_HOST_EMAIL }],
          });
          store.setSharingMode(EVENT_TYPE_ID, "TEAM");
          store.setSharingMembers(EVENT_TYPE_ID, [COLLEAGUE_ID]);
          store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: TEAM_ADMIN_ID });
          membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ATTENDEE_USER_ID });
          await addSession();
        });

        it("keeps the owner a HOST", async () => {
          const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

          expect(result.role).toBe("HOST");
        });

        it("keeps an event-type host who attends a HOST", async () => {
          const result = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: CO_HOST_ID });

          expect(result.role).toBe("HOST");
        });

        it("keeps a granted attendee an ATTENDEE", async () => {
          await grant();

          const result = await service.resolveViewerRole({
            bookingUid: BOOKING_UID,
            userId: ATTENDEE_USER_ID,
          });

          expect(result.role).toBe("ATTENDEE");
        });

        it("rejects an attendee without a grant even though they are in the chosen team", async () => {
          await expectDenied(ATTENDEE_USER_ID);
        });

        it("rejects every member of the chosen team in both modes, listed or not, with or without a grant", async () => {
          await expectDenied(COLLEAGUE_ID);
          await expectDenied(TEAM_ADMIN_ID);
          await expectDenied(STRANGER_ID);

          store.setSharingMode(EVENT_TYPE_ID, "SELECTED_PEOPLE");

          await expectDenied(COLLEAGUE_ID);
          await expectDenied(TEAM_ADMIN_ID);

          await grant();

          await expectDenied(COLLEAGUE_ID);
          await expectDenied(TEAM_ADMIN_ID);
        });
      });

      it("keeps host and attendee routes unchanged while sharing is on", async () => {
        addPersonalBooking();
        store.setSharingMode(EVENT_TYPE_ID, "TEAM");
        store.setVerifiedEmails(ATTENDEE_USER_ID, [ATTENDEE_EMAIL]);
        membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
        membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ATTENDEE_USER_ID });
        await addSession();
        await grant();

        const host = await service.resolveViewerRole({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });
        const attendee = await service.resolveViewerRole({
          bookingUid: BOOKING_UID,
          userId: ATTENDEE_USER_ID,
        });

        expect(host.role).toBe("HOST");
        expect(attendee.role).toBe("ATTENDEE");
      });

      it("refuses a shared viewer in assertHost", async () => {
        addPersonalBooking();
        store.setSharingMode(EVENT_TYPE_ID, "TEAM");
        membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
        membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: COLLEAGUE_ID });
        await addSession();

        const promise = service.assertHost({ bookingUid: BOOKING_UID, userId: COLLEAGUE_ID });

        await expect(promise).rejects.toMatchObject({
          code: ErrorCode.Forbidden,
          message: "Only a host of this booking can perform this action",
        });
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

  describe("resolveSharingScope", () => {
    it("returns null for HOSTS_ONLY and for a source without a team", async () => {
      membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });

      const hostsOnly = await service.resolveSharingScope({
        teamId: CHOSEN_TEAM_ID,
        teamName: CHOSEN_TEAM_NAME,
        organizationId: null,
        sharingOwnerUserId: ORGANIZER_ID,
        sharingMode: "HOSTS_ONLY",
      });
      const noTeam = await service.resolveSharingScope({
        teamId: null,
        teamName: null,
        organizationId: null,
        sharingOwnerUserId: null,
        sharingMode: "TEAM",
      });

      expect(hostsOnly).toBeNull();
      expect(noTeam).toBeNull();
    });

    it("returns the scope of a team event type without asking about an owner", async () => {
      const scope = await service.resolveSharingScope({
        teamId: TEAM_ID,
        teamName: "Support",
        organizationId: ORGANIZATION_ID,
        sharingOwnerUserId: null,
        sharingMode: "SELECTED_PEOPLE",
      });

      expect(scope).toEqual({
        mode: "SELECTED_PEOPLE",
        teamId: TEAM_ID,
        teamName: "Support",
        eligibilityTeamId: ORGANIZATION_ID,
      });
    });

    it("returns the chosen team of a personal event type while the owner is an accepted member", async () => {
      membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });

      const scope = await service.resolveSharingScope({
        teamId: CHOSEN_TEAM_ID,
        teamName: CHOSEN_TEAM_NAME,
        organizationId: null,
        sharingOwnerUserId: ORGANIZER_ID,
        sharingMode: "TEAM",
      });

      expect(scope).toEqual({
        mode: "TEAM",
        teamId: CHOSEN_TEAM_ID,
        teamName: CHOSEN_TEAM_NAME,
        eligibilityTeamId: CHOSEN_TEAM_ID,
      });
    });

    it("returns null for a personal event type whose owner is not an accepted member of the chosen team", async () => {
      const source = {
        teamId: CHOSEN_TEAM_ID,
        teamName: CHOSEN_TEAM_NAME,
        organizationId: null,
        sharingOwnerUserId: ORGANIZER_ID,
        sharingMode: "TEAM",
      } as const;

      expect(await service.resolveSharingScope(source)).toBeNull();

      membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID, accepted: false });

      expect(await service.resolveSharingScope(source)).toBeNull();
    });

    it("accepts a booking context as the source", async () => {
      store.addBooking(
        buildBooking({ teamId: CHOSEN_TEAM_ID, teamName: CHOSEN_TEAM_NAME, sharingOwnerUserId: ORGANIZER_ID })
      );
      store.setSharingMode(EVENT_TYPE_ID, "TEAM");
      membershipLookup.addMember({ teamId: CHOSEN_TEAM_ID, userId: ORGANIZER_ID });
      const booking = await service.assertHost({ bookingUid: BOOKING_UID, userId: ORGANIZER_ID });

      const scope = await service.resolveSharingScope(booking);

      expect(scope).toMatchObject({ mode: "TEAM", teamId: CHOSEN_TEAM_ID, teamName: CHOSEN_TEAM_NAME });
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
