import { beforeEach, describe, expect, it } from "vitest";
import type { InMemoryBookingSeed, InMemoryEventTypeSeed } from "./InMemoryNotetakerRepositories";
import { createInMemoryNotetakerRepositories } from "./InMemoryNotetakerRepositories";

const EVENT_TYPE_ID = 10;
const TEAM_ID = 20;

function bookingSeed(overrides: Partial<InMemoryBookingSeed> = {}): InMemoryBookingSeed {
  return {
    id: 100,
    uid: "uid-100",
    userId: 1,
    status: "ACCEPTED",
    startTime: new Date("2026-10-12T10:00:00.000Z"),
    endTime: new Date("2026-10-12T10:30:00.000Z"),
    title: "Planning call",
    location: null,
    metadata: null,
    recurringEventId: null,
    eventTypeId: EVENT_TYPE_ID,
    attendeeEmails: ["guest@example.com"],
    references: [],
    eventTypeHosts: [],
    organizer: { id: 1, name: "Organizer", email: "organizer@example.com", locale: "en" },
    ...overrides,
  };
}

function eventTypeSeed(overrides: Partial<InMemoryEventTypeSeed> = {}): InMemoryEventTypeSeed {
  return {
    id: EVENT_TYPE_ID,
    userId: null,
    teamId: TEAM_ID,
    locations: null,
    ownerName: null,
    ...overrides,
  };
}

describe("InMemoryNotetakerRepositories", () => {
  let repositories: ReturnType<typeof createInMemoryNotetakerRepositories>;

  beforeEach(() => {
    repositories = createInMemoryNotetakerRepositories();
  });

  async function addSession(
    bookingId: number,
    data: { colleagueSharingDisclosed?: boolean; dispatchedAt?: Date; withTranscript?: boolean } = {}
  ) {
    const session = await repositories.sessionRepository.create({
      bookingId,
      platform: "GOOGLE_MEET",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botProvider: "FAKE",
      displayName: "Notetaker",
      scheduledStartAt: new Date("2026-10-12T10:00:00.000Z"),
      dispatchedAt: data.dispatchedAt,
      colleagueSharingDisclosed: data.colleagueSharingDisclosed,
    });
    const transcript =
      data.withTranscript === false
        ? null
        : await repositories.transcriptRepository.createIfMissing({ sessionId: session.id, bookingId });
    return { session, transcript };
  }

  describe("booking context", () => {
    it("fills team fields with null and the sharing mode with HOSTS_ONLY by default", async () => {
      repositories.store.addBooking(bookingSeed());

      const full = await repositories.bookingNotetakerRepository.findByBookingIdIncludeBooking(100);

      expect(full).toMatchObject({
        teamId: null,
        teamName: null,
        organizationId: null,
        sharingMode: "HOSTS_ONLY",
      });
    });

    it("carries the seeded team fields and the mode of the event type settings", async () => {
      repositories.store.addBooking(bookingSeed({ teamId: TEAM_ID, teamName: "Sales", organizationId: 5 }));
      repositories.store.setSharingMode(EVENT_TYPE_ID, "TEAM");

      const full = await repositories.bookingNotetakerRepository.findByBookingUidIncludeBooking("uid-100");

      expect(full).toMatchObject({
        teamId: TEAM_ID,
        teamName: "Sales",
        organizationId: 5,
        sharingMode: "TEAM",
      });
    });

    it("keeps HOSTS_ONLY for a booking without an event type", async () => {
      repositories.store.addBooking(bookingSeed({ eventTypeId: null }));

      const full = await repositories.bookingNotetakerRepository.findByBookingIdIncludeBooking(100);

      expect(full?.sharingMode).toBe("HOSTS_ONLY");
    });
  });

  describe("event type settings", () => {
    beforeEach(() => {
      repositories.store.addEventType(
        eventTypeSeed({ title: "Intro", teamName: "Sales", organizationId: 5 })
      );
    });

    it("returns defaults for the new context fields", async () => {
      repositories.store.addEventType(eventTypeSeed({ id: 11 }));

      const context =
        await repositories.eventTypeNotetakerSettingsRepository.findByEventTypeIdIncludeEventType(11);

      expect(context).toMatchObject({ title: "", teamName: null, organizationId: null, settings: null });
    });

    it("upsert keeps the sharing fields of an existing row and defaults new rows", async () => {
      const fresh = await repositories.eventTypeNotetakerSettingsRepository.upsert({
        eventTypeId: EVENT_TYPE_ID,
        enabledByDefault: true,
      });
      expect(fresh).toMatchObject({
        sharingMode: "HOSTS_ONLY",
        sharingSetByUserId: null,
        sharingSetAt: null,
      });

      const setAt = new Date("2026-10-01T00:00:00.000Z");
      await repositories.eventTypeNotetakerSettingsRepository.updateSharing({
        eventTypeId: EVENT_TYPE_ID,
        sharingMode: "TEAM",
        sharingSetByUserId: 7,
        sharingSetAt: setAt,
        change: {
          actorUserId: 7,
          actorName: "Ann",
          previousMode: "HOSTS_ONLY",
          newMode: "TEAM",
          addedUserNames: [],
          removedUserNames: [],
        },
      });
      const again = await repositories.eventTypeNotetakerSettingsRepository.upsert({
        eventTypeId: EVENT_TYPE_ID,
        enabledByDefault: false,
      });

      expect(again).toMatchObject({
        enabledByDefault: false,
        sharingMode: "TEAM",
        sharingSetByUserId: 7,
        sharingSetAt: setAt,
      });
    });

    it("updateSharing creates the row with enabledByDefault false and stores one change", async () => {
      await repositories.eventTypeNotetakerSettingsRepository.updateSharing({
        eventTypeId: EVENT_TYPE_ID,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: 7,
        sharingSetAt: new Date("2026-10-01T00:00:00.000Z"),
        memberUserIds: [3, 2],
        change: {
          actorUserId: 7,
          actorName: "Ann",
          previousMode: "HOSTS_ONLY",
          newMode: "SELECTED_PEOPLE",
          addedUserNames: ["Bob", "Cy"],
          removedUserNames: [],
        },
      });

      const settings =
        await repositories.eventTypeNotetakerSettingsRepository.findByEventTypeId(EVENT_TYPE_ID);
      expect(settings).toMatchObject({ enabledByDefault: false, sharingMode: "SELECTED_PEOPLE" });
      expect(repositories.store.sharingChanges).toHaveLength(1);
      expect(repositories.store.sharingChanges[0]).toMatchObject({
        eventTypeId: EVENT_TYPE_ID,
        addedUserNames: ["Bob", "Cy"],
      });
    });

    it("updateSharing keeps addedAt and addedByUserId of members that stay and leaves the list alone without memberUserIds", async () => {
      const repo = repositories.eventTypeNotetakerSettingsRepository;
      const change = {
        actorUserId: 7,
        actorName: "Ann",
        previousMode: "SELECTED_PEOPLE" as const,
        newMode: "SELECTED_PEOPLE" as const,
        addedUserNames: [],
        removedUserNames: [],
      };
      const earlier = new Date("2026-01-01T00:00:00.000Z");
      repositories.store.sharingMembers.set(EVENT_TYPE_ID, [
        { userId: 2, addedByUserId: 9, addedAt: earlier },
      ]);

      await repo.updateSharing({
        eventTypeId: EVENT_TYPE_ID,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: 7,
        sharingSetAt: new Date(),
        memberUserIds: [2, 4],
        change,
      });
      await repo.updateSharing({
        eventTypeId: EVENT_TYPE_ID,
        sharingMode: "TEAM",
        sharingSetByUserId: 7,
        sharingSetAt: new Date(),
        change,
      });

      const rows = repositories.store.sharingMembers.get(EVENT_TYPE_ID) ?? [];
      expect(rows.map((row) => row.userId)).toEqual([2, 4]);
      expect(rows[0]).toMatchObject({ addedAt: earlier, addedByUserId: 9 });
      expect(rows[1].addedByUserId).toBe(7);
      expect(repositories.store.sharingChanges).toHaveLength(2);
    });

    it("updateSharing removes members that are no longer listed", async () => {
      repositories.store.setSharingMembers(EVENT_TYPE_ID, [2, 3]);

      await repositories.eventTypeNotetakerSettingsRepository.updateSharing({
        eventTypeId: EVENT_TYPE_ID,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: 7,
        sharingSetAt: new Date(),
        memberUserIds: [3],
        change: {
          actorUserId: 7,
          actorName: null,
          previousMode: "SELECTED_PEOPLE",
          newMode: "SELECTED_PEOPLE",
          addedUserNames: [],
          removedUserNames: ["B"],
        },
      });

      expect(
        await repositories.eventTypeNotetakerSettingsRepository.hasSharingMember({
          eventTypeId: EVENT_TYPE_ID,
          userId: 2,
        })
      ).toBe(false);
      expect(
        await repositories.eventTypeNotetakerSettingsRepository.hasSharingMember({
          eventTypeId: EVENT_TYPE_ID,
          userId: 3,
        })
      ).toBe(true);
    });

    it("lists members with user data ordered by addedAt then userId, with a fallback for unknown users", async () => {
      repositories.store.setUser(3, { name: "Cy", email: "cy@example.com", avatarUrl: "/cy.png" });
      repositories.store.setSharingMembers(EVENT_TYPE_ID, [3, 2]);

      const members =
        await repositories.eventTypeNotetakerSettingsRepository.findSharingMembersIncludeUser(EVENT_TYPE_ID);

      expect(members.map((member) => member.userId)).toEqual([2, 3]);
      expect(members[0]).toMatchObject({ name: null, email: "user2@example.com", avatarUrl: null });
      expect(members[1]).toMatchObject({ name: "Cy", email: "cy@example.com", avatarUrl: "/cy.png" });
    });

    it("hasSharingMember is false without a list", async () => {
      expect(
        await repositories.eventTypeNotetakerSettingsRepository.hasSharingMember({
          eventTypeId: EVENT_TYPE_ID,
          userId: 2,
        })
      ).toBe(false);
    });

    it("returns changes since a date, newest first, within the limit", async () => {
      const store = repositories.store;
      const base = {
        eventTypeId: EVENT_TYPE_ID,
        actorUserId: null,
        actorName: null,
        previousMode: "HOSTS_ONLY" as const,
        newMode: "TEAM" as const,
        addedUserNames: [],
        removedUserNames: [],
      };
      store.sharingChanges.push(
        { ...base, id: "a", createdAt: new Date("2026-10-01T00:00:00.000Z") },
        { ...base, id: "b", createdAt: new Date("2026-10-03T00:00:00.000Z") },
        { ...base, id: "c", createdAt: new Date("2026-10-03T00:00:00.000Z") },
        { ...base, id: "d", eventTypeId: 99, createdAt: new Date("2026-10-04T00:00:00.000Z") },
        { ...base, id: "e", createdAt: new Date("2026-09-01T00:00:00.000Z") }
      );
      const repo = repositories.eventTypeNotetakerSettingsRepository;

      const all = await repo.findSharingChangesByEventTypeIdSince({
        eventTypeId: EVENT_TYPE_ID,
        since: new Date("2026-10-01T00:00:00.000Z"),
        limit: 10,
      });
      const limited = await repo.findSharingChangesByEventTypeIdSince({
        eventTypeId: EVENT_TYPE_ID,
        since: new Date("2026-10-01T00:00:00.000Z"),
        limit: 2,
      });

      expect(all.map((change) => change.id)).toEqual(["c", "b", "a"]);
      expect(limited.map((change) => change.id)).toEqual(["c", "b"]);
    });

    it("finds team event types by team ids and mode", async () => {
      const store = repositories.store;
      store.addEventType(eventTypeSeed({ id: 11, teamId: 21, title: "Other", teamName: "Ops" }));
      store.addEventType(eventTypeSeed({ id: 12, teamId: null }));
      store.addEventType(eventTypeSeed({ id: 13, teamId: TEAM_ID, title: "Hosts only" }));
      store.setSharingMode(EVENT_TYPE_ID, "TEAM");
      store.setSharingMode(11, "TEAM");
      store.setSharingMode(12, "TEAM");
      store.setSharingMode(13, "HOSTS_ONLY");
      const repo = repositories.eventTypeNotetakerSettingsRepository;

      const found = await repo.findByTeamIdsAndSharingModeIncludeEventType({
        teamIds: [TEAM_ID],
        sharingMode: "TEAM",
      });

      expect(found).toEqual([
        {
          eventTypeId: EVENT_TYPE_ID,
          eventTypeTitle: "Intro",
          teamId: TEAM_ID,
          teamName: "Sales",
          organizationId: 5,
          sharingMode: "TEAM",
        },
      ]);
      expect(
        await repo.findByTeamIdsAndSharingModeIncludeEventType({ teamIds: [], sharingMode: "TEAM" })
      ).toEqual([]);
    });

    it("finds event types by sharing member whatever the mode and skips event types without a team", async () => {
      const store = repositories.store;
      store.addEventType(eventTypeSeed({ id: 11, teamId: null }));
      store.setSharingMembers(EVENT_TYPE_ID, [2]);
      store.setSharingMembers(11, [2]);
      store.setSharingMembers(99, [2]);
      store.setSharingMode(EVENT_TYPE_ID, "TEAM");

      const found =
        await repositories.eventTypeNotetakerSettingsRepository.findBySharingMemberUserIdIncludeEventType({
          userId: 2,
        });

      expect(found).toEqual([
        {
          eventTypeId: EVENT_TYPE_ID,
          eventTypeTitle: "Intro",
          teamId: TEAM_ID,
          teamName: "Sales",
          organizationId: 5,
          sharingMode: "TEAM",
        },
      ]);
      expect(
        await repositories.eventTypeNotetakerSettingsRepository.findBySharingMemberUserIdIncludeEventType({
          userId: 8,
        })
      ).toEqual([]);
    });
  });

  describe("findByEventTypeIdsIncludeResultsSession", () => {
    const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`);

    async function addDisclosedBooking(id: number, day: number) {
      repositories.store.addBooking(bookingSeed({ id, uid: `uid-${id}`, startTime: at(day) }));
      return addSession(id, { colleagueSharingDisclosed: true });
    }

    it("returns [] for no event type ids", async () => {
      await addDisclosedBooking(100, 10);

      expect(
        await repositories.bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
          eventTypeIds: [],
          cursor: null,
          limit: 10,
        })
      ).toEqual([]);
    });

    it("orders by startTime desc then id desc and pages with a cursor", async () => {
      await addDisclosedBooking(100, 10);
      await addDisclosedBooking(101, 12);
      await addDisclosedBooking(102, 12);
      await addDisclosedBooking(103, 11);
      const repo = repositories.bookingNotetakerRepository;

      const first = await repo.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [EVENT_TYPE_ID],
        cursor: null,
        limit: 2,
      });
      const second = await repo.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [EVENT_TYPE_ID],
        cursor: { startTime: first[1].startTime, id: first[1].bookingId },
        limit: 5,
      });

      expect(first.map((row) => row.bookingId)).toEqual([102, 101]);
      expect(second.map((row) => row.bookingId)).toEqual([103, 100]);
    });

    it("keeps only bookings of the given event types with a disclosed session that has a transcript", async () => {
      await addDisclosedBooking(100, 10);
      repositories.store.addBooking(bookingSeed({ id: 101, uid: "uid-101", eventTypeId: 99 }));
      await addSession(101, { colleagueSharingDisclosed: true });
      repositories.store.addBooking(bookingSeed({ id: 102, uid: "uid-102" }));
      await addSession(102, { colleagueSharingDisclosed: false });
      repositories.store.addBooking(bookingSeed({ id: 103, uid: "uid-103" }));
      await addSession(103, { colleagueSharingDisclosed: true, withTranscript: false });
      repositories.store.addBooking(bookingSeed({ id: 104, uid: "uid-104", eventTypeId: null }));

      const rows = await repositories.bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [EVENT_TYPE_ID],
        cursor: null,
        limit: 10,
      });

      expect(rows.map((row) => row.bookingId)).toEqual([100]);
    });

    it("reports the latest session that has a transcript, with its summary status and organizer", async () => {
      repositories.store.addBooking(bookingSeed({ attendeeEmails: ["a@example.com", "b@example.com"] }));
      await addSession(100, {
        colleagueSharingDisclosed: true,
        dispatchedAt: new Date("2026-10-12T09:00:00.000Z"),
      });
      const later = await addSession(100, {
        colleagueSharingDisclosed: false,
        dispatchedAt: new Date("2026-10-12T11:00:00.000Z"),
      });
      await repositories.summaryRepository.upsertPending(later.transcript?.id ?? "");
      await addSession(100, { withTranscript: false, dispatchedAt: new Date("2026-10-12T12:00:00.000Z") });

      const [row] = await repositories.bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [EVENT_TYPE_ID],
        cursor: null,
        limit: 10,
      });

      expect(row).toMatchObject({
        bookingId: 100,
        bookingUid: "uid-100",
        organizerUserId: 1,
        organizerName: "Organizer",
        attendeeEmails: ["a@example.com", "b@example.com"],
        resultsSession: {
          id: later.session.id,
          colleagueSharingDisclosed: false,
          resultsDeletedAt: null,
          summaryStatus: "PENDING",
        },
      });
    });

    it("gives a null summary status without a summary", async () => {
      await addDisclosedBooking(100, 10);

      const [row] = await repositories.bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
        eventTypeIds: [EVENT_TYPE_ID],
        cursor: null,
        limit: 10,
      });

      expect(row.resultsSession?.summaryStatus).toBeNull();
    });
  });

  describe("sessions", () => {
    beforeEach(() => {
      repositories.store.addBooking(bookingSeed());
    });

    it("defaults colleagueSharingDisclosed to false and stores true when given", async () => {
      const plain = await addSession(100, {});
      const disclosed = await addSession(100, { colleagueSharingDisclosed: true });

      expect(plain.session.colleagueSharingDisclosed).toBe(false);
      expect(disclosed.session.colleagueSharingDisclosed).toBe(true);
    });

    it("never updates colleagueSharingDisclosed through update", async () => {
      const { session } = await addSession(100, { colleagueSharingDisclosed: true });

      await repositories.sessionRepository.update(session.id, { status: "ENDED" });

      expect((await repositories.sessionRepository.findById(session.id))?.colleagueSharingDisclosed).toBe(
        true
      );
    });

    it("finds the earliest session by createdAt then id", async () => {
      const first = await addSession(100, { dispatchedAt: new Date("2026-10-12T12:00:00.000Z") });
      await addSession(100, { dispatchedAt: new Date("2026-10-12T08:00:00.000Z") });

      const earliest = await repositories.sessionRepository.findEarliestByBookingId(100);

      expect(earliest?.id).toBe(first.session.id);
      expect(await repositories.sessionRepository.findEarliestByBookingId(999)).toBeNull();
    });
  });

  describe("transcripts", () => {
    beforeEach(() => {
      repositories.store.addBooking(bookingSeed());
    });

    it("creates a transcript with speakerNamesAvailable null and updates it", async () => {
      const { transcript } = await addSession(100, {});
      expect(transcript?.speakerNamesAvailable).toBeNull();

      const updated = await repositories.transcriptRepository.update(transcript?.id ?? "", {
        speakerNamesAvailable: false,
      });

      expect(updated.speakerNamesAvailable).toBe(false);
    });

    it("updatePassageSpeakersBySpeakerKey renames the matching passages only and returns the count", async () => {
      const { transcript } = await addSession(100, {});
      const transcriptId = transcript?.id ?? "";
      const passage = (index: number, speakerKey: string, unknownSpeakerNumber: number | null) => ({
        index,
        speakerKey,
        speakerName: unknownSpeakerNumber === null ? "Alex" : null,
        unknownSpeakerNumber,
        startMs: index * 1000,
        endMs: index * 1000 + 500,
        text: `text ${index}`,
        language: null,
      });
      await repositories.transcriptRepository.insertPassages(transcriptId, [
        passage(0, "unknown:1", 1),
        passage(1, "participant:alex", null),
        passage(2, "unknown:1", 1),
        passage(3, "unknown:2", 2),
      ]);

      const count = await repositories.transcriptRepository.updatePassageSpeakersBySpeakerKey({
        transcriptId,
        speakerKey: "unknown:1",
        resolvedSpeakerKey: "participant:sam",
        speakerName: "Sam",
      });
      const passages = await repositories.transcriptRepository.findAllPassages(transcriptId);

      expect(count).toBe(2);
      expect(passages.map((p) => [p.speakerKey, p.speakerName, p.unknownSpeakerNumber])).toEqual([
        ["participant:sam", "Sam", null],
        ["participant:alex", "Alex", null],
        ["participant:sam", "Sam", null],
        ["unknown:2", null, 2],
      ]);
      expect(
        await repositories.transcriptRepository.updatePassageSpeakersBySpeakerKey({
          transcriptId,
          speakerKey: "unknown:9",
          resolvedSpeakerKey: "participant:x",
          speakerName: "X",
        })
      ).toBe(0);
    });
  });

  describe("activities", () => {
    beforeEach(() => {
      repositories.store.addBooking(bookingSeed());
    });

    it("existsByBookingIdAndActionAndActorUserId matches booking, action and actor", async () => {
      await repositories.activityRepository.create({
        bookingId: 100,
        sessionId: null,
        action: "SHARED_VIEWED",
        actorType: "USER",
        actorUserId: 4,
        actorName: "Dee",
        detail: null,
      });
      const repo = repositories.activityRepository;

      expect(
        await repo.existsByBookingIdAndActionAndActorUserId({
          bookingId: 100,
          action: "SHARED_VIEWED",
          actorUserId: 4,
        })
      ).toBe(true);
      expect(
        await repo.existsByBookingIdAndActionAndActorUserId({
          bookingId: 100,
          action: "SHARED_VIEWED",
          actorUserId: 5,
        })
      ).toBe(false);
      expect(
        await repo.existsByBookingIdAndActionAndActorUserId({
          bookingId: 100,
          action: "EXPORTED",
          actorUserId: 4,
        })
      ).toBe(false);
      expect(
        await repo.existsByBookingIdAndActionAndActorUserId({
          bookingId: 101,
          action: "SHARED_VIEWED",
          actorUserId: 4,
        })
      ).toBe(false);
    });
  });
});
