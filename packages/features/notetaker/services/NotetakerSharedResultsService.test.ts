import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { NotetakerSessionRecord } from "../repositories/interfaces/INotetakerSessionRepository";
import { InMemoryNotetakerMembershipLookup } from "../tests/InMemoryNotetakerMembershipLookup";
import type { InMemoryBookingSeed } from "../tests/InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "../tests/InMemoryNotetakerRepositories";
import { NotetakerSharedResultsService } from "./NotetakerSharedResultsService";

const VIEWER_ID = 7;
const VIEWER_PRIMARY_EMAIL = "viewer@example.com";
const VIEWER_SECONDARY_EMAIL = "viewer.second@example.com";
const ORGANIZER_ID = 1;
const ORGANIZER_NAME = "Olivia Organizer";

const ORGANIZATION_ID = 50;
const TEAM_ID = 20;
const OTHER_TEAM_ID = 21;
const TEAM_NAME = "Sales";
const OTHER_TEAM_NAME = "Support";

const TEAM_EVENT_TYPE_ID = 10;
const SELECTED_EVENT_TYPE_ID = 11;
const TEAM_EVENT_TYPE_TITLE = "Discovery call";
const SELECTED_EVENT_TYPE_TITLE = "Escalation call";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_START = new Date("2026-10-01T10:00:00.000Z");

function buildBooking(id: number, overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  const startTime = new Date(BASE_START.getTime() + id * DAY_MS);
  return {
    id,
    uid: `booking-uid-${id}`,
    userId: ORGANIZER_ID,
    status: "ACCEPTED",
    startTime,
    endTime: new Date(startTime.getTime() + 30 * 60 * 1000),
    title: `Call ${id}`,
    location: null,
    metadata: null,
    recurringEventId: null,
    eventTypeId: TEAM_EVENT_TYPE_ID,
    attendeeEmails: ["guest@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: ORGANIZER_ID, name: ORGANIZER_NAME, email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
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

async function expectBadRequest(promise: Promise<unknown>, message: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  expect(error).toMatchObject({ code: ErrorCode.BadRequest, message });
}

describe("NotetakerSharedResultsService", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;
  let membershipLookup: InMemoryNotetakerMembershipLookup;
  let users: NotetakerUserRecord[];
  let service: NotetakerSharedResultsService;

  beforeEach(() => {
    repositories = createInMemoryNotetakerRepositories();
    membershipLookup = new InMemoryNotetakerMembershipLookup();
    users = [buildUser(VIEWER_ID, { email: VIEWER_PRIMARY_EMAIL })];
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) => users.filter((user) => ids.includes(user.id)),
    };
    service = new NotetakerSharedResultsService({
      bookingNotetakerRepository: repositories.bookingNotetakerRepository,
      eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
      membershipLookup,
      userRepository,
    });

    repositories.store.addEventType({
      id: TEAM_EVENT_TYPE_ID,
      userId: null,
      teamId: TEAM_ID,
      locations: [],
      ownerName: null,
      title: TEAM_EVENT_TYPE_TITLE,
      teamName: TEAM_NAME,
      organizationId: ORGANIZATION_ID,
    });
    repositories.store.setSharingMode(TEAM_EVENT_TYPE_ID, "TEAM");
    repositories.store.addEventType({
      id: SELECTED_EVENT_TYPE_ID,
      userId: null,
      teamId: OTHER_TEAM_ID,
      locations: [],
      ownerName: null,
      title: SELECTED_EVENT_TYPE_TITLE,
      teamName: OTHER_TEAM_NAME,
      organizationId: ORGANIZATION_ID,
    });
    repositories.store.setSharingMode(SELECTED_EVENT_TYPE_ID, "SELECTED_PEOPLE");
    repositories.store.setSharingMembers(SELECTED_EVENT_TYPE_ID, [VIEWER_ID]);
  });

  function joinTeamAndOrganization(): void {
    membershipLookup.addMember({ teamId: TEAM_ID, userId: VIEWER_ID });
    membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
  }

  async function seedSession(
    bookingId: number,
    options: { disclosed?: boolean; withTranscript?: boolean; dispatchedAt?: Date } = {}
  ): Promise<NotetakerSessionRecord> {
    const session = await repositories.sessionRepository.create({
      bookingId,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: BASE_START,
      dispatchedAt: options.dispatchedAt ?? BASE_START,
      colleagueSharingDisclosed: options.disclosed ?? true,
    });
    if (options.withTranscript !== false) {
      await repositories.transcriptRepository.createIfMissing({ sessionId: session.id, bookingId });
    }
    return session;
  }

  async function seedSharedBooking(
    id: number,
    overrides: Partial<InMemoryBookingSeed> = {}
  ): Promise<NotetakerSessionRecord> {
    repositories.store.addBooking(buildBooking(id, overrides));
    return seedSession(id);
  }

  async function listUids(params: { cursor?: string | null; limit?: number } = {}): Promise<string[]> {
    const page = await service.list({ userId: VIEWER_ID, ...params });
    return page.items.map((item) => item.bookingUid);
  }

  describe("routes", () => {
    it("lists a booking of an event type shared with the whole team", async () => {
      joinTeamAndOrganization();
      const session = await seedSharedBooking(1);
      const transcript = await repositories.transcriptRepository.findBySessionId(session.id);
      if (!transcript) throw new Error("transcript was not seeded");
      await repositories.summaryRepository.upsertPending(transcript.id);

      const page = await service.list({ userId: VIEWER_ID });

      expect(page).toEqual({
        items: [
          {
            bookingUid: "booking-uid-1",
            title: "Call 1",
            startTime: buildBooking(1).startTime.toISOString(),
            eventTypeTitle: TEAM_EVENT_TYPE_TITLE,
            teamName: TEAM_NAME,
            hostName: ORGANIZER_NAME,
            route: "TEAM",
            summaryStatus: "PENDING",
          },
        ],
        nextCursor: null,
      });
    });

    it("lists a booking of an event type that names the viewer", async () => {
      membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID, organizer: null, userId: null });

      const page = await service.list({ userId: VIEWER_ID });

      expect(page.items).toEqual([
        {
          bookingUid: "booking-uid-2",
          title: "Call 2",
          startTime: buildBooking(2).startTime.toISOString(),
          eventTypeTitle: SELECTED_EVENT_TYPE_TITLE,
          teamName: OTHER_TEAM_NAME,
          hostName: null,
          route: "SELECTED_PEOPLE",
          summaryStatus: null,
        },
      ]);
    });

    it("checks the team of a selected-people event type that has no organization", async () => {
      repositories.store.addEventType({
        id: SELECTED_EVENT_TYPE_ID,
        userId: null,
        teamId: OTHER_TEAM_ID,
        locations: [],
        ownerName: null,
        title: SELECTED_EVENT_TYPE_TITLE,
        teamName: OTHER_TEAM_NAME,
        organizationId: null,
      });
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });

      membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
      expect(await listUids()).toEqual([]);

      membershipLookup.addMember({ teamId: OTHER_TEAM_ID, userId: VIEWER_ID });
      expect(await listUids()).toEqual(["booking-uid-2"]);
    });

    it("lists both routes together, newest first", async () => {
      joinTeamAndOrganization();
      await seedSharedBooking(1);
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });
      await seedSharedBooking(3);

      const page = await service.list({ userId: VIEWER_ID });

      expect(page.items.map((item) => [item.bookingUid, item.route])).toEqual([
        ["booking-uid-3", "TEAM"],
        ["booking-uid-2", "SELECTED_PEOPLE"],
        ["booking-uid-1", "TEAM"],
      ]);
    });

    it("gives an empty page to a user with no accepted membership", async () => {
      membershipLookup.addMember({ teamId: TEAM_ID, userId: VIEWER_ID, accepted: false });
      await seedSharedBooking(1);
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });

      expect(await service.list({ userId: VIEWER_ID })).toEqual({ items: [], nextCursor: null });
    });

    it("gives an empty page when no event type is shared with the viewer", async () => {
      membershipLookup.addMember({ teamId: 999, userId: VIEWER_ID });
      await seedSharedBooking(1);
      const find = vi.spyOn(
        repositories.bookingNotetakerRepository,
        "findByEventTypeIdsIncludeResultsSession"
      );

      expect(await service.list({ userId: VIEWER_ID })).toEqual({ items: [], nextCursor: null });
      expect(find).not.toHaveBeenCalled();
    });

    it("shows nothing to a listed person who left the organization", async () => {
      membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });
      expect(await listUids()).toEqual(["booking-uid-2"]);

      membershipLookup.removeMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
      membershipLookup.addMember({ teamId: 999, userId: VIEWER_ID });

      expect(await listUids()).toEqual([]);
    });

    it("shows nothing to a listed person under mode TEAM who is not a team member", async () => {
      membershipLookup.addMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });
      repositories.store.setSharingMode(SELECTED_EVENT_TYPE_ID, "TEAM");
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });

      expect(await listUids()).toEqual([]);
    });

    it("shows nothing for an event type that went back to hosts only", async () => {
      joinTeamAndOrganization();
      await seedSharedBooking(1);
      await seedSharedBooking(2, { eventTypeId: SELECTED_EVENT_TYPE_ID });
      repositories.store.setSharingMode(TEAM_EVENT_TYPE_ID, "HOSTS_ONLY");
      repositories.store.setSharingMode(SELECTED_EVENT_TYPE_ID, "HOSTS_ONLY");

      expect(await listUids()).toEqual([]);
    });
  });

  describe("results that are not readable", () => {
    beforeEach(() => {
      joinTeamAndOrganization();
    });

    it("leaves out a booking whose session was not disclosed", async () => {
      repositories.store.addBooking(buildBooking(1));
      await seedSession(1, { disclosed: false });

      expect(await listUids()).toEqual([]);
    });

    it("leaves out a booking whose latest transcript session was not disclosed", async () => {
      repositories.store.addBooking(buildBooking(1));
      await seedSession(1, { disclosed: true, dispatchedAt: new Date("2026-10-02T09:55:00.000Z") });
      await seedSession(1, { disclosed: false, dispatchedAt: new Date("2026-10-02T10:20:00.000Z") });

      expect(await listUids()).toEqual([]);
    });

    it("leaves out a booking without a transcript", async () => {
      repositories.store.addBooking(buildBooking(1));
      await seedSession(1, { withTranscript: false });

      expect(await listUids()).toEqual([]);
    });

    it("leaves out a booking whose results were deleted", async () => {
      const session = await seedSharedBooking(1);
      await repositories.sessionRepository.setResultsDeletedAtByIds([session.id], new Date());

      expect(await listUids()).toEqual([]);
    });

    it("leaves out a row that comes back without a results session", async () => {
      const startTime = buildBooking(1).startTime;
      const stubbed = new NotetakerSharedResultsService({
        bookingNotetakerRepository: {
          findVerifiedEmailsByUserId: async () => [],
          findByEventTypeIdsIncludeResultsSession: async () => [
            {
              bookingId: 1,
              bookingUid: "booking-uid-1",
              title: "Call 1",
              startTime,
              eventTypeId: TEAM_EVENT_TYPE_ID,
              organizerUserId: ORGANIZER_ID,
              organizerName: ORGANIZER_NAME,
              attendeeEmails: [],
              resultsSession: null,
            },
          ],
        },
        eventTypeNotetakerSettingsRepository: repositories.eventTypeNotetakerSettingsRepository,
        membershipLookup,
        userRepository: { findByIds: async () => [] },
      });

      expect(await stubbed.list({ userId: VIEWER_ID })).toEqual({ items: [], nextCursor: null });
    });
  });

  describe("the viewer's own bookings", () => {
    beforeEach(() => {
      joinTeamAndOrganization();
    });

    it("leaves out a booking the viewer organizes", async () => {
      await seedSharedBooking(1, { userId: VIEWER_ID });
      await seedSharedBooking(2);

      expect(await listUids()).toEqual(["booking-uid-2"]);
    });

    it("leaves out a booking the viewer attends under a verified email", async () => {
      repositories.store.setVerifiedEmails(VIEWER_ID, [VIEWER_SECONDARY_EMAIL]);
      await seedSharedBooking(1, { attendeeEmails: ["guest@example.com", " Viewer.Second@Example.com "] });
      await seedSharedBooking(2);

      expect(await listUids()).toEqual(["booking-uid-2"]);
    });

    it("leaves out a booking the viewer attends under the primary email", async () => {
      await seedSharedBooking(1, { attendeeEmails: ["VIEWER@example.com"] });
      await seedSharedBooking(2);

      expect(await listUids()).toEqual(["booking-uid-2"]);
    });
  });

  describe("paging", () => {
    beforeEach(() => {
      joinTeamAndOrganization();
    });

    it("walks three pages with the cursor and ends with null", async () => {
      for (const id of [1, 2, 3, 4, 5]) {
        await seedSharedBooking(id);
      }

      const first = await service.list({ userId: VIEWER_ID, limit: 2 });
      expect(first.items.map((item) => item.bookingUid)).toEqual(["booking-uid-5", "booking-uid-4"]);
      expect(first.nextCursor).toBe(`${buildBooking(4).startTime.toISOString()}|4`);

      const second = await service.list({ userId: VIEWER_ID, limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.bookingUid)).toEqual(["booking-uid-3", "booking-uid-2"]);
      expect(second.nextCursor).toBe(`${buildBooking(2).startTime.toISOString()}|2`);

      const third = await service.list({ userId: VIEWER_ID, limit: 2, cursor: second.nextCursor });
      expect(third.items.map((item) => item.bookingUid)).toEqual(["booking-uid-1"]);
      expect(third.nextCursor).toBeNull();
    });

    it("orders bookings of the same start time by id and pages through them", async () => {
      const startTime = buildBooking(1).startTime;
      for (const id of [1, 2, 3]) {
        await seedSharedBooking(id, { startTime });
      }

      const first = await service.list({ userId: VIEWER_ID, limit: 2 });
      const second = await service.list({ userId: VIEWER_ID, limit: 2, cursor: first.nextCursor });

      expect(first.items.map((item) => item.bookingUid)).toEqual(["booking-uid-3", "booking-uid-2"]);
      expect(second.items.map((item) => item.bookingUid)).toEqual(["booking-uid-1"]);
    });

    it("keeps the cursor of the fetched page when the filter empties it", async () => {
      await seedSharedBooking(1);
      await seedSharedBooking(2, { userId: VIEWER_ID });
      await seedSharedBooking(3, { userId: VIEWER_ID });

      const first = await service.list({ userId: VIEWER_ID, limit: 2 });
      expect(first).toEqual({ items: [], nextCursor: `${buildBooking(2).startTime.toISOString()}|2` });

      const second = await service.list({ userId: VIEWER_ID, limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.bookingUid)).toEqual(["booking-uid-1"]);
      expect(second.nextCursor).toBeNull();
    });

    it.each([
      "not-a-cursor",
      "2026-10-02T10:00:00.000Z",
      "2026-10-02T10:00:00.000Z|",
      "2026-10-02T10:00:00.000Z|abc",
      "2026-10-02T10:00:00.000Z|1.5",
      "2026-10-02T10:00:00.000Z|1|2",
      "yesterday|1",
      "|1",
      "",
    ])("refuses the cursor %j", async (cursor) => {
      await seedSharedBooking(1);

      await expectBadRequest(service.list({ userId: VIEWER_ID, cursor }), "INVALID_CURSOR");
    });

    it("refuses a bad cursor even when nothing is shared with the viewer", async () => {
      membershipLookup.removeMember({ teamId: TEAM_ID, userId: VIEWER_ID });
      membershipLookup.removeMember({ teamId: ORGANIZATION_ID, userId: VIEWER_ID });

      await expectBadRequest(service.list({ userId: VIEWER_ID, cursor: "not-a-cursor" }), "INVALID_CURSOR");
    });

    it.each([
      { limit: undefined, fetched: 21 },
      { limit: 0, fetched: 2 },
      { limit: -5, fetched: 2 },
      { limit: 50, fetched: 51 },
      { limit: 500, fetched: 51 },
    ])("clamps limit $limit and fetches $fetched rows", async ({ limit, fetched }) => {
      await seedSharedBooking(1);
      const find = vi.spyOn(
        repositories.bookingNotetakerRepository,
        "findByEventTypeIdsIncludeResultsSession"
      );

      await service.list({ userId: VIEWER_ID, limit });

      expect(find).toHaveBeenCalledTimes(1);
      expect(find.mock.calls[0][0]).toMatchObject({ cursor: null, limit: fetched });
    });

    it("asks only for the event types shared with the viewer", async () => {
      await seedSharedBooking(1);
      const find = vi.spyOn(
        repositories.bookingNotetakerRepository,
        "findByEventTypeIdsIncludeResultsSession"
      );

      await service.list({ userId: VIEWER_ID });

      expect(find.mock.calls[0][0].eventTypeIds).toEqual([TEAM_EVENT_TYPE_ID, SELECTED_EVENT_TYPE_ID]);
    });
  });
});
