import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  INotetakerCalendarEventsGateway,
  INotetakerCalendarEventsGatewayResolver,
  NotetakerAutoJoinCalendarRecord,
} from "../calendar/INotetakerCalendarEventsGateway";
import { NOTETAKER_AD_HOC_SHARING_TEAM_KEY } from "../lib/adHocMeeting";
import type { NotetakerCalendarEvent } from "../lib/calendarMeeting";
import { NOTETAKER_CALENDAR_MEETING_KEY } from "../lib/calendarMeeting";
import type { NotetakerConfig } from "../lib/config";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { INotetakerCalendarAutoJoinRepository } from "../repositories/interfaces/INotetakerCalendarAutoJoinRepository";
import type {
  INotetakerCalendarMeetingRepository,
  NotetakerCalDiyBookingMatchRecord,
  NotetakerCalendarMeetingRecord,
} from "../repositories/interfaces/INotetakerCalendarMeetingRepository";
import type {
  INotetakerMeetingContactRepository,
  NotetakerMeetingContactRecord,
} from "../repositories/interfaces/INotetakerMeetingContactRepository";
import { NotetakerCalendarAutoJoinService } from "./NotetakerCalendarAutoJoinService";

vi.mock("@calcom/i18n/server", () => ({
  getTranslation: vi.fn(async (locale: string, _namespace: string) => (key: string) => `${locale}:${key}`),
}));

const NOW = new Date("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// One poll interval (5 min) plus a minute, so calendars polled at NOW are due again.
const LATER = new Date(NOW.getTime() + 6 * MINUTE_MS);
const EVEN_LATER = new Date(LATER.getTime() + 6 * MINUTE_MS);

const GOOGLE = "google_calendar";
const MEET_URL = "https://meet.google.com/abc-defg-hij";
const MEET_KEY = `GOOGLE_MEET:${MEET_URL}`;
const OTHER_MEET_URL = "https://meet.google.com/xyz-wxyz-xyz";
const OTHER_MEET_KEY = `GOOGLE_MEET:${OTHER_MEET_URL}`;
const NOTETAKER_FLAG = "notetaker";
const AUTO_JOIN_FLAG = "notetaker-calendar-auto-join";

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
    adHocLimits: { maxActiveMeetings: 10, maxMeetingsPerDay: 50 },
    calendarAutoJoin: {
      pollIntervalSeconds: 300,
      lookaheadHours: 24,
      pollBatchSize: 20,
      maxMeetingsPerDay: 10,
    },
    enabledPlatforms: ["GOOGLE_MEET"],
    botProvider: "FAKE",
    botUrl: null,
    botSecret: null,
    summaryModel: "test-model",
    anthropicApiKey: null,
    fakeScenario: "happy",
    googleAccountEmail: null,
    botName: null,
    recall: null,
    ...overrides,
  };
}

function buildCalendar(
  userId: number,
  overrides: Partial<NotetakerAutoJoinCalendarRecord> = {}
): NotetakerAutoJoinCalendarRecord {
  return {
    selectedCalendarId: `cal-${userId}`,
    userId,
    integration: GOOGLE,
    externalId: `user${userId}@example.com`,
    credentialId: userId,
    delegationCredentialId: null,
    sharingTeamId: null,
    lastPolledAt: null,
    ...overrides,
  };
}

function buildEvent(overrides: Partial<NotetakerCalendarEvent> = {}): NotetakerCalendarEvent {
  return {
    externalId: "evt-1",
    iCalUID: "ical-1",
    recurringEventId: null,
    title: "Weekly sync",
    start: new Date(NOW.getTime() + HOUR_MS),
    end: new Date(NOW.getTime() + 2 * HOUR_MS),
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    organizerEmail: "guest@example.com",
    attendeeEmails: ["guest@example.com", "user1@example.com"],
    candidateLinks: [MEET_URL],
    ...overrides,
  };
}

type StoredParticipant = {
  userId: number;
  selectedCalendarId: string;
  externalEventId: string;
  lastSeenAt: Date;
  removedAt: Date | null;
};

type StoredMeeting = {
  id: string;
  bookingId: number;
  bookingUid: string;
  ownerUserId: number;
  meetingKey: string;
  startTime: Date;
  endTime: Date;
  iCalUID: string | null;
  title: string;
  meetingUrl: string;
  metadata: Record<string, string>;
  hasSession: boolean;
  cancelled: boolean;
  notetakerEnabled: boolean;
  createdAt: Date;
  participants: StoredParticipant[];
  attendeeEmails: string[];
};

type StoredCalDiyBooking = NotetakerCalDiyBookingMatchRecord & {
  iCalUID: string | null;
  referenceUid: string | null;
};

class FakeMeetingRepository implements Omit<INotetakerCalendarMeetingRepository, "isParticipant"> {
  meetings: StoredMeeting[] = [];
  calDiyBookings: StoredCalDiyBooking[] = [];
  enabledBookingIds: number[] = [];
  // Runs inside createWithBooking before the uniqueness check, so a test can race a competing insert.
  beforeCreate: (() => Promise<void>) | null = null;
  private nextId = 1;

  private toRecord(meeting: StoredMeeting): NotetakerCalendarMeetingRecord {
    return {
      id: meeting.id,
      bookingId: meeting.bookingId,
      bookingUid: meeting.bookingUid,
      ownerUserId: meeting.ownerUserId,
      meetingKey: meeting.meetingKey,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      hasSession: meeting.hasSession,
      participants: [...meeting.participants]
        .sort((a, b) => a.userId - b.userId)
        .map(({ userId, selectedCalendarId, externalEventId, removedAt }) => ({
          userId,
          selectedCalendarId,
          externalEventId,
          removedAt,
        })),
    };
  }

  private byId(meetingId: string): StoredMeeting {
    const meeting = this.meetings.find((m) => m.id === meetingId);
    if (!meeting) throw new Error(`meeting ${meetingId} not found`);
    return meeting;
  }

  private findStoredByKey(meetingKey: string, startTime: Date): StoredMeeting | undefined {
    return this.meetings.find(
      (m) => m.meetingKey === meetingKey && m.startTime.getTime() === startTime.getTime()
    );
  }

  async findByParticipantEvent(params: { selectedCalendarId: string; externalEventId: string }) {
    const matches = this.meetings
      .filter((m) =>
        m.participants.some(
          (p) =>
            p.selectedCalendarId === params.selectedCalendarId && p.externalEventId === params.externalEventId
        )
      )
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
    return matches[0] ? this.toRecord(matches[0]) : null;
  }

  async findByKey(params: { meetingKey: string; startTime: Date }) {
    const meeting = this.findStoredByKey(params.meetingKey, params.startTime);
    return meeting ? this.toRecord(meeting) : null;
  }

  async findActiveByCalendarInRange(params: { selectedCalendarId: string; from: Date; to: Date }) {
    return this.meetings
      .filter(
        (m) =>
          m.startTime.getTime() >= params.from.getTime() &&
          m.startTime.getTime() < params.to.getTime() &&
          m.participants.some(
            (p) => p.selectedCalendarId === params.selectedCalendarId && p.removedAt === null
          )
      )
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
      .map((m) => this.toRecord(m));
  }

  async createWithBooking(params: Parameters<INotetakerCalendarMeetingRepository["createWithBooking"]>[0]) {
    if (this.beforeCreate) {
      const hook = this.beforeCreate;
      this.beforeCreate = null;
      await hook();
    }
    if (this.findStoredByKey(params.meetingKey, params.startTime)) return "CONFLICT" as const;
    const id = this.nextId;
    this.nextId += 1;
    const meeting: StoredMeeting = {
      id: `meeting-${id}`,
      bookingId: id,
      bookingUid: params.bookingUid,
      ownerUserId: params.owner.userId,
      meetingKey: params.meetingKey,
      startTime: params.startTime,
      endTime: params.endTime,
      iCalUID: params.iCalUID,
      title: params.title,
      meetingUrl: params.meetingUrl,
      metadata: params.metadata,
      hasSession: false,
      cancelled: false,
      notetakerEnabled: true,
      createdAt: params.seenAt,
      participants: [
        {
          userId: params.owner.userId,
          selectedCalendarId: params.owner.selectedCalendarId,
          externalEventId: params.owner.externalEventId,
          lastSeenAt: params.seenAt,
          removedAt: null,
        },
      ],
      attendeeEmails: [],
    };
    this.meetings.push(meeting);
    return this.toRecord(meeting);
  }

  async upsertParticipant(params: Parameters<INotetakerCalendarMeetingRepository["upsertParticipant"]>[0]) {
    const meeting = this.byId(params.meetingId);
    const participant = meeting.participants.find((p) => p.userId === params.userId);
    if (participant) {
      participant.selectedCalendarId = params.selectedCalendarId;
      participant.externalEventId = params.externalEventId;
      participant.lastSeenAt = params.seenAt;
      participant.removedAt = null;
    } else {
      meeting.participants.push({
        userId: params.userId,
        selectedCalendarId: params.selectedCalendarId,
        externalEventId: params.externalEventId,
        lastSeenAt: params.seenAt,
        removedAt: null,
      });
    }
    if (meeting.ownerUserId === params.userId) return;
    if (meeting.attendeeEmails.some((email) => email.toLowerCase() === params.email.toLowerCase())) return;
    meeting.attendeeEmails.push(params.email);
  }

  async markParticipantRemoved(params: { meetingId: string; userId: number; at: Date }) {
    const participant = this.byId(params.meetingId).participants.find((p) => p.userId === params.userId);
    if (participant && participant.removedAt === null) participant.removedAt = params.at;
  }

  async touchParticipant(params: { meetingId: string; userId: number; seenAt: Date }) {
    const participant = this.byId(params.meetingId).participants.find((p) => p.userId === params.userId);
    if (participant) participant.lastSeenAt = params.seenAt;
  }

  async reschedule(params: Parameters<INotetakerCalendarMeetingRepository["reschedule"]>[0]) {
    const other = this.findStoredByKey(params.meetingKey, params.startTime);
    if (other && other.id !== params.meetingId) return "CONFLICT" as const;
    const meeting = this.byId(params.meetingId);
    meeting.startTime = params.startTime;
    meeting.endTime = params.endTime;
    meeting.meetingKey = params.meetingKey;
    meeting.meetingUrl = params.meetingUrl;
    return "OK" as const;
  }

  async transferOwner(params: { meetingId: string; bookingId: number; userId: number }) {
    this.byId(params.meetingId).ownerUserId = params.userId;
  }

  async cancel(params: { meetingId: string; bookingId: number }) {
    const meeting = this.byId(params.meetingId);
    meeting.cancelled = true;
    meeting.notetakerEnabled = false;
  }

  async revive(params: Parameters<INotetakerCalendarMeetingRepository["revive"]>[0]) {
    const meeting = this.byId(params.meetingId);
    meeting.cancelled = false;
    meeting.notetakerEnabled = true;
    meeting.ownerUserId = params.userId;
    const participant = meeting.participants.find((p) => p.userId === params.userId);
    if (participant) {
      participant.selectedCalendarId = params.selectedCalendarId;
      participant.externalEventId = params.externalEventId;
      participant.lastSeenAt = params.seenAt;
      participant.removedAt = null;
      return;
    }
    meeting.participants.push({
      userId: params.userId,
      selectedCalendarId: params.selectedCalendarId,
      externalEventId: params.externalEventId,
      lastSeenAt: params.seenAt,
      removedAt: null,
    });
  }

  async listActiveParticipantUserIds(params: { bookingId: number }) {
    const meeting = this.meetings.find((m) => m.bookingId === params.bookingId);
    return meeting ? meeting.participants.filter((p) => p.removedAt === null).map((p) => p.userId) : [];
  }

  async countCreatedByOwnerSince(params: { userId: number; since: Date }) {
    return this.meetings.filter(
      (m) => m.ownerUserId === params.userId && m.createdAt.getTime() >= params.since.getTime()
    ).length;
  }

  async findCalDiyBookingForEvent(params: { iCalUID: string | null; externalEventId: string }) {
    const booking = this.calDiyBookings.find(
      (b) =>
        b.referenceUid === params.externalEventId ||
        (params.iCalUID !== null && b.iCalUID !== null && b.iCalUID === params.iCalUID)
    );
    if (!booking) return null;
    const { bookingId, hostUserId, hasNotetakerChoice } = booking;
    return { bookingId, hostUserId, hasNotetakerChoice };
  }

  async enableChoiceForCalendarAutoJoin(params: { bookingId: number }) {
    const booking = this.calDiyBookings.find((b) => b.bookingId === params.bookingId);
    if (!booking || booking.hasNotetakerChoice) return false;
    booking.hasNotetakerChoice = true;
    this.enabledBookingIds.push(params.bookingId);
    return true;
  }
}

class FakeAutoJoinRepository
  implements Pick<INotetakerCalendarAutoJoinRepository, "findDueForPoll" | "markPolled">
{
  calendars: NotetakerAutoJoinCalendarRecord[] = [];
  polled: { selectedCalendarId: string; at: Date; error: string | null }[] = [];

  async findDueForPoll(params: { polledBefore: Date; integrations: string[]; limit: number }) {
    return this.calendars
      .filter(
        (c) =>
          params.integrations.includes(c.integration) &&
          (c.lastPolledAt === null || c.lastPolledAt.getTime() < params.polledBefore.getTime())
      )
      .slice(0, params.limit);
  }

  async markPolled(params: { selectedCalendarId: string; at: Date; error: string | null }) {
    this.polled.push(params);
    const calendar = this.calendars.find((c) => c.selectedCalendarId === params.selectedCalendarId);
    if (calendar) calendar.lastPolledAt = params.at;
  }

  polledError(selectedCalendarId: string): string | null | undefined {
    return this.polled.find((p) => p.selectedCalendarId === selectedCalendarId)?.error;
  }
}

class FakeMeetingContactRepository implements Pick<INotetakerMeetingContactRepository, "replaceForSource"> {
  contacts = new Map<number, NotetakerMeetingContactRecord[]>();
  failWith: Error | null = null;

  async replaceForSource(params: Parameters<INotetakerMeetingContactRepository["replaceForSource"]>[0]) {
    if (this.failWith) throw this.failWith;
    const kept = (this.contacts.get(params.bookingId) ?? []).filter((c) => c.source !== params.source);
    const emails = new Set(kept.map((c) => c.email));
    for (const contact of params.contacts) {
      if (emails.has(contact.email)) continue;
      emails.add(contact.email);
      kept.push({ ...contact, source: params.source });
    }
    this.contacts.set(params.bookingId, kept);
  }

  emailsFor(bookingId: number): string[] {
    return (this.contacts.get(bookingId) ?? []).map((c) => c.email);
  }
}

type EventsSource = NotetakerCalendarEvent[] | (() => Promise<NotetakerCalendarEvent[]>);

class FakeEventsGateway implements INotetakerCalendarEventsGateway {
  events = new Map<string, EventsSource>();
  calls: string[] = [];

  async listEvents(p: { calendar: NotetakerAutoJoinCalendarRecord; timeMin: Date; timeMax: Date }) {
    this.calls.push(p.calendar.selectedCalendarId);
    const source = this.events.get(p.calendar.selectedCalendarId) ?? [];
    return typeof source === "function" ? source() : source;
  }
}

describe("NotetakerCalendarAutoJoinService", () => {
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  let meetings: FakeMeetingRepository;
  let autoJoin: FakeAutoJoinRepository;
  let gateway: FakeEventsGateway;
  let disabledFlags: Set<string>;
  let users: Map<number, NotetakerUserRecord>;
  let contacts: FakeMeetingContactRepository;
  let verifiedEmails: Map<number, string[]>;
  let service: NotetakerCalendarAutoJoinService;

  function buildService(config: NotetakerConfig = buildConfig()): NotetakerCalendarAutoJoinService {
    const resolver: INotetakerCalendarEventsGatewayResolver = {
      resolve: (integration) => (integration === GOOGLE ? gateway : null),
      supportedIntegrations: () => [GOOGLE],
    };
    const userRepository: INotetakerUserLookup = {
      findByIds: async ({ ids }) =>
        ids.flatMap((id) => {
          const user = users.get(id);
          return user ? [user] : [];
        }),
    };
    return new NotetakerCalendarAutoJoinService({
      autoJoinRepository: autoJoin,
      calendarMeetingRepository: meetings,
      meetingContactRepository: contacts,
      bookingNotetakerRepository: {
        findVerifiedEmailsByUserId: async (userId) => verifiedEmails.get(userId) ?? [],
      },
      eventsGatewayResolver: resolver,
      featuresRepository: {
        checkIfUserHasFeature: async (userId, slug) => !disabledFlags.has(`${userId}:${slug}`),
      },
      userRepository,
      config,
      logger,
    });
  }

  function addUser(id: number, overrides: Partial<NotetakerUserRecord> = {}): void {
    users.set(id, {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`,
      locale: "en",
      timeZone: "UTC",
      ...overrides,
    });
  }

  function addCalendar(
    userId: number,
    events: EventsSource,
    overrides: Partial<NotetakerAutoJoinCalendarRecord> = {}
  ) {
    const calendar = buildCalendar(userId, overrides);
    autoJoin.calendars.push(calendar);
    gateway.events.set(calendar.selectedCalendarId, events);
    return calendar;
  }

  function eventForUser(
    userId: number,
    overrides: Partial<NotetakerCalendarEvent> = {}
  ): NotetakerCalendarEvent {
    return buildEvent({
      externalId: `evt-u${userId}`,
      iCalUID: `ical-u${userId}`,
      attendeeEmails: ["guest@example.com", `user${userId}@example.com`],
      ...overrides,
    });
  }

  beforeEach(() => {
    meetings = new FakeMeetingRepository();
    autoJoin = new FakeAutoJoinRepository();
    gateway = new FakeEventsGateway();
    disabledFlags = new Set();
    users = new Map();
    contacts = new FakeMeetingContactRepository();
    verifiedEmails = new Map();
    addUser(1);
    addUser(2);
    addUser(3);
    service = buildService();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("creating meetings", () => {
    it("creates a meeting with a booking for an accepted event with a Meet link", async () => {
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toEqual({
        calendarsPolled: 1,
        created: 1,
        joined: 0,
        removed: 0,
        enabledBookings: 0,
        failed: 0,
      });
      expect(meetings.meetings).toHaveLength(1);
      const meeting = meetings.meetings[0];
      expect(meeting).toMatchObject({
        ownerUserId: 1,
        title: "Weekly sync",
        meetingUrl: MEET_URL,
        meetingKey: MEET_KEY,
        iCalUID: "ical-1",
        startTime: new Date(NOW.getTime() + HOUR_MS),
        endTime: new Date(NOW.getTime() + 2 * HOUR_MS),
        metadata: { [NOTETAKER_CALENDAR_MEETING_KEY]: "true" },
        cancelled: false,
      });
      expect(meeting.bookingUid).toMatch(/^[A-Za-z0-9]+$/);
      expect(meeting.participants).toEqual([
        {
          userId: 1,
          selectedCalendarId: "cal-1",
          externalEventId: "evt-1",
          lastSeenAt: NOW,
          removedAt: null,
        },
      ]);
      expect(autoJoin.polled).toEqual([{ selectedCalendarId: "cal-1", at: NOW, error: null }]);
    });

    it("stores the calendar's sharing team in the booking metadata", async () => {
      addCalendar(1, [buildEvent()], { sharingTeamId: 42 });

      await service.pollDue(NOW);

      expect(meetings.meetings[0].metadata).toEqual({
        [NOTETAKER_CALENDAR_MEETING_KEY]: "true",
        [NOTETAKER_AD_HOC_SHARING_TEAM_KEY]: "42",
      });
    });

    it("falls back to the translated default title and clamps the end time to the bot's limit", async () => {
      addUser(1, { locale: "de" });
      addCalendar(1, [buildEvent({ title: "  ", end: new Date(NOW.getTime() + 10 * HOUR_MS) })]);
      service = buildService(buildConfig({ limits: { ...buildConfig().limits, maxDurationSeconds: 3600 } }));

      await service.pollDue(NOW);

      expect(meetings.meetings[0].title).toBe("de:notetaker_ad_hoc_default_title");
      expect(meetings.meetings[0].endTime).toEqual(new Date(NOW.getTime() + 2 * HOUR_MS));
    });

    it("skips events the decision rejects without touching the repository", async () => {
      addCalendar(1, [
        buildEvent({ externalId: "declined", selfResponse: "declined" }),
        buildEvent({ externalId: "tentative", selfResponse: "tentative" }),
        buildEvent({ externalId: "solo", attendeeEmails: ["user1@example.com"] }),
        buildEvent({ externalId: "no-link", candidateLinks: [] }),
      ]);

      const counts = await service.pollDue(NOW);

      expect(counts.created).toBe(0);
      expect(meetings.meetings).toHaveLength(0);
    });

    it("only touches the participant when nothing changed on a later poll", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ calendarsPolled: 1, created: 0, joined: 0, removed: 0 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0].participants[0].lastSeenAt).toEqual(LATER);
    });

    it("stops creating meetings for an owner at the daily cap", async () => {
      service = buildService(
        buildConfig({ calendarAutoJoin: { ...buildConfig().calendarAutoJoin, maxMeetingsPerDay: 1 } })
      );
      addCalendar(1, [
        buildEvent({ externalId: "evt-a" }),
        buildEvent({
          externalId: "evt-b",
          iCalUID: "ical-b",
          candidateLinks: [OTHER_MEET_URL],
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);

      const counts = await service.pollDue(NOW);

      expect(counts.created).toBe(1);
      expect(meetings.meetings).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "Notetaker calendar meeting not created: daily cap reached",
        expect.objectContaining({ userId: 1, createdToday: 1 })
      );
    });
  });

  describe("joining shared meetings", () => {
    it("adds a second user with the same link and time to the existing meeting in the same poll", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 1, joined: 1 });
      expect(meetings.meetings).toHaveLength(1);
      const meeting = meetings.meetings[0];
      expect(meeting.ownerUserId).toBe(1);
      expect(meeting.participants.map((p) => [p.userId, p.selectedCalendarId, p.externalEventId])).toEqual([
        [1, "cal-1", "evt-u1"],
        [2, "cal-2", "evt-u2"],
      ]);
      expect(meeting.attendeeEmails).toEqual(["user2@example.com"]);
    });

    it("adds a second user to a meeting created in an earlier poll", async () => {
      addCalendar(1, [eventForUser(1)]);
      await service.pollDue(NOW);
      addCalendar(2, [eventForUser(2)]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ calendarsPolled: 2, created: 0, joined: 1 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0].participants.map((p) => p.userId)).toEqual([1, 2]);
    });

    it("joins the meeting that won a concurrent create", async () => {
      addCalendar(1, [eventForUser(1)]);
      meetings.beforeCreate = async () => {
        await meetings.createWithBooking({
          bookingUid: "raced",
          title: "Raced",
          meetingUrl: MEET_URL,
          meetingKey: MEET_KEY,
          startTime: new Date(NOW.getTime() + HOUR_MS),
          endTime: new Date(NOW.getTime() + 2 * HOUR_MS),
          iCalUID: null,
          metadata: {},
          owner: {
            userId: 2,
            email: "user2@example.com",
            name: "User 2",
            timeZone: "UTC",
            selectedCalendarId: "cal-2",
            externalEventId: "evt-u2",
          },
          seenAt: NOW,
        });
      };

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 0, joined: 1, failed: 0 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0].ownerUserId).toBe(2);
      expect(meetings.meetings[0].participants.map((p) => p.userId)).toEqual([2, 1]);
    });

    it("re-adds a user who accepts again after declining while others kept the meeting", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [eventForUser(1, { selfResponse: "declined" })]);
      await service.pollDue(LATER);
      const afterDecline = meetings.meetings[0].participants.find((p) => p.userId === 1);
      expect(afterDecline?.removedAt).toEqual(LATER);
      gateway.events.set("cal-1", [eventForUser(1)]);

      const counts = await service.pollDue(EVEN_LATER);

      expect(counts).toMatchObject({ created: 0, joined: 1 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0].participants.find((p) => p.userId === 1)?.removedAt).toBeNull();
    });
  });

  describe("rescheduling", () => {
    it("moves the meeting when the only participant's event changes time and link", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      const meetingId = meetings.meetings[0].id;
      gateway.events.set("cal-1", [
        buildEvent({
          candidateLinks: [OTHER_MEET_URL],
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ created: 0, joined: 0, removed: 0 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0]).toMatchObject({
        id: meetingId,
        meetingKey: OTHER_MEET_KEY,
        meetingUrl: OTHER_MEET_URL,
        startTime: new Date(NOW.getTime() + 3 * HOUR_MS),
        endTime: new Date(NOW.getTime() + 4 * HOUR_MS),
        cancelled: false,
      });
      expect(meetings.meetings[0].participants[0].lastSeenAt).toEqual(LATER);
    });

    it("splits the user off into a new meeting when others still share the old one", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [
        eventForUser(1, {
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ created: 1, joined: 0, removed: 0 });
      expect(meetings.meetings).toHaveLength(2);
      const [old, moved] = meetings.meetings;
      expect(old.cancelled).toBe(false);
      expect(old.ownerUserId).toBe(2);
      expect(old.participants.find((p) => p.userId === 1)?.removedAt).toEqual(LATER);
      expect(old.participants.find((p) => p.userId === 2)?.removedAt).toBeNull();
      expect(moved).toMatchObject({
        ownerUserId: 1,
        meetingKey: MEET_KEY,
        startTime: new Date(NOW.getTime() + 3 * HOUR_MS),
      });
    });

    it("merges into the other meeting when the rescheduled slot is already taken", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [
        eventForUser(2, {
          candidateLinks: [OTHER_MEET_URL],
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);
      await service.pollDue(NOW);
      expect(meetings.meetings).toHaveLength(2);
      gateway.events.set("cal-1", [
        eventForUser(1, {
          candidateLinks: [OTHER_MEET_URL],
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ created: 0, joined: 1, removed: 1 });
      const own = meetings.meetings.find((m) => m.ownerUserId === 1);
      const other = meetings.meetings.find((m) => m.ownerUserId === 2);
      expect(own?.cancelled).toBe(true);
      expect(own?.participants[0].removedAt).toEqual(LATER);
      expect(other?.participants.map((p) => p.userId)).toEqual([2, 1]);
    });
  });

  describe("leaving meetings", () => {
    it("cancels the meeting when the last participant declines", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [buildEvent({ selfResponse: "declined" })]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ removed: 1 });
      expect(meetings.meetings[0].cancelled).toBe(true);
      expect(meetings.meetings[0].participants[0].removedAt).toEqual(LATER);
    });

    it("cancels the meeting when the event is cancelled", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [buildEvent({ status: "cancelled" })]);

      await service.pollDue(LATER);

      expect(meetings.meetings[0].cancelled).toBe(true);
    });

    it("cancels the meeting when the event disappears from the calendar", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", []);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ removed: 1 });
      expect(meetings.meetings[0].cancelled).toBe(true);
    });

    it("transfers ownership to the remaining participant when the owner leaves", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [eventForUser(1, { selfResponse: "declined" })]);

      const counts = await service.pollDue(LATER);

      expect(counts).toMatchObject({ removed: 0 });
      const meeting = meetings.meetings[0];
      expect(meeting.cancelled).toBe(false);
      expect(meeting.ownerUserId).toBe(2);
      expect(meeting.participants.find((p) => p.userId === 1)?.removedAt).toEqual(LATER);
      expect(meeting.participants.find((p) => p.userId === 2)?.removedAt).toBeNull();
    });

    it("keeps the owner when a non-owner leaves", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);
      await service.pollDue(NOW);
      gateway.events.set("cal-2", []);

      await service.pollDue(LATER);

      expect(meetings.meetings[0].ownerUserId).toBe(1);
      expect(meetings.meetings[0].cancelled).toBe(false);
    });

    it("never cancels or reschedules a meeting whose bot session exists", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      meetings.meetings[0].hasSession = true;
      gateway.events.set("cal-1", [
        buildEvent({
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
        }),
      ]);
      await service.pollDue(LATER);
      expect(meetings.meetings[0].startTime).toEqual(new Date(NOW.getTime() + HOUR_MS));
      expect(meetings.meetings[0].participants[0].lastSeenAt).toEqual(LATER);

      gateway.events.set("cal-1", [buildEvent({ selfResponse: "declined" })]);
      const counts = await service.pollDue(EVEN_LATER);

      expect(counts).toMatchObject({ removed: 0 });
      expect(meetings.meetings[0].cancelled).toBe(false);
      expect(meetings.meetings[0].participants[0].removedAt).not.toBeNull();
    });
  });

  describe("reviving cancelled meetings", () => {
    it("revives the meeting when the last participant accepts the same event again after declining", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [buildEvent({ selfResponse: "declined" })]);
      await service.pollDue(LATER);
      expect(meetings.meetings[0]).toMatchObject({ cancelled: true, notetakerEnabled: false });
      gateway.events.set("cal-1", [buildEvent()]);

      const counts = await service.pollDue(EVEN_LATER);

      expect(counts).toMatchObject({ created: 1, joined: 0, removed: 0, failed: 0 });
      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0]).toMatchObject({
        cancelled: false,
        notetakerEnabled: true,
        ownerUserId: 1,
      });
      expect(meetings.meetings[0].participants).toEqual([
        {
          userId: 1,
          selectedCalendarId: "cal-1",
          externalEventId: "evt-1",
          lastSeenAt: EVEN_LATER,
          removedAt: null,
        },
      ]);
    });

    it("revives the meeting when its event reappears after disappearing from the window", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", []);
      await service.pollDue(LATER);
      expect(meetings.meetings[0].cancelled).toBe(true);
      gateway.events.set("cal-1", [buildEvent()]);

      await service.pollDue(EVEN_LATER);

      expect(meetings.meetings).toHaveLength(1);
      expect(meetings.meetings[0]).toMatchObject({ cancelled: false, notetakerEnabled: true });
      expect(meetings.meetings[0].participants[0].removedAt).toBeNull();
    });

    it("lets another user's calendar revive a cancelled meeting and become its owner", async () => {
      addCalendar(1, [eventForUser(1)]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [eventForUser(1, { selfResponse: "declined" })]);
      await service.pollDue(LATER);
      expect(meetings.meetings[0].cancelled).toBe(true);
      addCalendar(2, [eventForUser(2)]);

      await service.pollDue(EVEN_LATER);

      expect(meetings.meetings).toHaveLength(1);
      const meeting = meetings.meetings[0];
      expect(meeting).toMatchObject({ cancelled: false, notetakerEnabled: true, ownerUserId: 2 });
      expect(meeting.participants.find((p) => p.userId === 1)?.removedAt).toEqual(LATER);
      expect(meeting.participants.find((p) => p.userId === 2)).toMatchObject({
        selectedCalendarId: "cal-2",
        externalEventId: "evt-u2",
        removedAt: null,
      });
    });

    it("does not revive a meeting at the user's daily cap", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [buildEvent({ selfResponse: "declined" })]);
      await service.pollDue(LATER);
      service = buildService(
        buildConfig({ calendarAutoJoin: { ...buildConfig().calendarAutoJoin, maxMeetingsPerDay: 1 } })
      );
      gateway.events.set("cal-1", [buildEvent()]);

      const counts = await service.pollDue(EVEN_LATER);

      expect(counts.created).toBe(0);
      expect(meetings.meetings[0].cancelled).toBe(true);
    });

    it("leaves a meeting with a session untouched even when nobody is left in it", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      meetings.meetings[0].hasSession = true;
      gateway.events.set("cal-1", [buildEvent({ selfResponse: "declined" })]);
      await service.pollDue(LATER);
      gateway.events.set("cal-1", [buildEvent()]);

      const counts = await service.pollDue(EVEN_LATER);

      expect(counts).toMatchObject({ created: 0, joined: 0 });
      expect(meetings.meetings[0].participants[0].removedAt).toEqual(LATER);
    });
  });

  describe("Cal.diy bookings found in the calendar", () => {
    it("enables the notetaker on the user's own booking instead of creating a meeting", async () => {
      meetings.calDiyBookings.push({
        bookingId: 77,
        hostUserId: 1,
        hasNotetakerChoice: false,
        iCalUID: null,
        referenceUid: "evt-1",
      });
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 0, enabledBookings: 1 });
      expect(meetings.enabledBookingIds).toEqual([77]);
      expect(meetings.meetings).toHaveLength(0);
    });

    it("matches the booking by iCalUID as well", async () => {
      meetings.calDiyBookings.push({
        bookingId: 78,
        hostUserId: 1,
        hasNotetakerChoice: false,
        iCalUID: "ical-1",
        referenceUid: null,
      });
      addCalendar(1, [buildEvent()]);

      await service.pollDue(NOW);

      expect(meetings.enabledBookingIds).toEqual([78]);
    });

    it("leaves a booking with an explicit choice untouched", async () => {
      meetings.calDiyBookings.push({
        bookingId: 77,
        hostUserId: 1,
        hasNotetakerChoice: true,
        iCalUID: null,
        referenceUid: "evt-1",
      });
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 0, enabledBookings: 0 });
      expect(meetings.enabledBookingIds).toEqual([]);
      expect(meetings.meetings).toHaveLength(0);
    });

    it("leaves someone else's booking to its host", async () => {
      meetings.calDiyBookings.push({
        bookingId: 77,
        hostUserId: 2,
        hasNotetakerChoice: false,
        iCalUID: null,
        referenceUid: "evt-1",
      });
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 0, enabledBookings: 0 });
      expect(meetings.meetings).toHaveLength(0);
    });

    it("does not enable the notetaker for a booking whose event the user has not accepted", async () => {
      meetings.calDiyBookings.push({
        bookingId: 77,
        hostUserId: 1,
        hasNotetakerChoice: false,
        iCalUID: null,
        referenceUid: "evt-1",
      });
      addCalendar(1, [buildEvent({ selfResponse: "declined" })]);

      await service.pollDue(NOW);

      expect(meetings.enabledBookingIds).toEqual([]);
    });
  });

  describe("calendar contacts", () => {
    it("stores the event's other attendees with their names when it creates a meeting", async () => {
      addCalendar(1, [
        buildEvent({
          attendeeEmails: ["guest@example.com", "user1@example.com", "second@example.com"],
          attendees: [
            { email: "guest@example.com", name: "Guest Person" },
            { email: "user1@example.com", name: "User 1" },
            { email: "second@example.com", name: null },
          ],
        }),
      ]);

      await service.pollDue(NOW);

      expect(contacts.contacts.get(meetings.meetings[0].bookingId)).toEqual([
        { email: "guest@example.com", name: "Guest Person", source: "CALENDAR" },
        { email: "second@example.com", name: null, source: "CALENDAR" },
      ]);
      expect(meetings.meetings[0].attendeeEmails).toEqual([]);
    });

    it("falls back to the attendee emails and adds an organizer who is not the owner", async () => {
      addCalendar(1, [
        buildEvent({ organizerEmail: "boss@example.com", attendeeEmails: ["guest@example.com"] }),
      ]);

      await service.pollDue(NOW);

      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toEqual([
        "guest@example.com",
        "boss@example.com",
      ]);
    });

    it("leaves out the owner's verified emails, the owner as organizer, other Cal participants and rooms", async () => {
      verifiedEmails.set(1, ["owner.alias@example.com"]);
      verifiedEmails.set(2, ["second.alias@example.com"]);
      const shared = {
        organizerEmail: "owner.organizer@example.com",
        selfResponse: "organizer" as const,
        attendeeEmails: [
          "guest@example.com",
          "user1@example.com",
          "owner.alias@example.com",
          "user2@example.com",
          "second.alias@example.com",
          "room-1@resource.calendar.google.com",
        ],
      };
      addCalendar(1, [eventForUser(1, shared)]);
      addCalendar(2, [eventForUser(2, { ...shared, selfResponse: "accepted" })]);
      await service.pollDue(NOW);

      await service.pollDue(LATER);

      expect(meetings.meetings).toHaveLength(1);
      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toEqual(["guest@example.com"]);
    });

    it("caps the stored contacts", async () => {
      const guests = Array.from({ length: 60 }, (_, index) => `guest${index}@example.com`);
      addCalendar(1, [buildEvent({ attendeeEmails: guests })]);

      await service.pollDue(NOW);

      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toHaveLength(50);
    });

    it("replaces the calendar contacts on a later poll", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [
        buildEvent({ organizerEmail: null, attendeeEmails: ["new@example.com", "user1@example.com"] }),
      ]);

      await service.pollDue(LATER);

      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toEqual(["new@example.com"]);
    });

    it("keeps manual contacts when it replaces the calendar ones", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      const bookingId = meetings.meetings[0].bookingId;
      await contacts.replaceForSource({
        bookingId,
        source: "MANUAL",
        contacts: [{ email: "manual@example.com", name: null }],
      });
      gateway.events.set("cal-1", [
        buildEvent({ organizerEmail: null, attendeeEmails: ["new@example.com", "user1@example.com"] }),
      ]);

      await service.pollDue(LATER);

      expect(contacts.contacts.get(bookingId)).toEqual([
        { email: "manual@example.com", name: null, source: "MANUAL" },
        { email: "new@example.com", name: null, source: "CALENDAR" },
      ]);
    });

    it("updates the contacts after rescheduling the meeting", async () => {
      addCalendar(1, [buildEvent()]);
      await service.pollDue(NOW);
      gateway.events.set("cal-1", [
        buildEvent({
          candidateLinks: [OTHER_MEET_URL],
          start: new Date(NOW.getTime() + 3 * HOUR_MS),
          end: new Date(NOW.getTime() + 4 * HOUR_MS),
          organizerEmail: null,
          attendeeEmails: ["new@example.com", "user1@example.com"],
        }),
      ]);

      await service.pollDue(LATER);

      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toEqual(["new@example.com"]);
    });

    it("does not touch the contacts once the meeting has ended", async () => {
      addCalendar(1, [buildEvent({ end: new Date(NOW.getTime() + HOUR_MS + 5 * 60 * 1000) })]);
      await service.pollDue(NOW);
      const bookingId = meetings.meetings[0].bookingId;
      const meeting = meetings.meetings[0];
      meeting.endTime = new Date(NOW.getTime() + 3 * 60 * 1000);
      gateway.events.set("cal-1", [
        buildEvent({
          end: new Date(NOW.getTime() + HOUR_MS + 5 * 60 * 1000),
          attendeeEmails: ["new@example.com", "user1@example.com"],
        }),
      ]);
      meeting.hasSession = true;

      await service.pollDue(LATER);

      expect(contacts.emailsFor(bookingId)).toEqual(["guest@example.com"]);
    });

    it("lets only the owner's calendar change the contacts", async () => {
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2, { attendeeEmails: ["other@example.com", "user2@example.com"] })]);

      await service.pollDue(NOW);
      await service.pollDue(LATER);

      expect(contacts.emailsFor(meetings.meetings[0].bookingId)).toEqual(["guest@example.com"]);
    });

    it("keeps auto-join working and logs no emails when storing contacts fails", async () => {
      contacts.failWith = new Error("insert failed for guest@example.com");
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ created: 1, failed: 0 });
      expect(logger.warn).toHaveBeenCalledWith("Notetaker calendar meeting contacts could not be stored", {
        meetingId: meetings.meetings[0].id,
        bookingId: meetings.meetings[0].bookingId,
        selectedCalendarId: "cal-1",
        errorName: "Error",
      });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("guest@example.com");
    });
  });

  describe("polling", () => {
    it("returns zeros without polling when the bot provider is unusable", async () => {
      service = buildService(buildConfig({ botProvider: null }));
      addCalendar(1, [buildEvent()]);

      const counts = await service.pollDue(NOW);

      expect(counts).toEqual({
        calendarsPolled: 0,
        created: 0,
        joined: 0,
        removed: 0,
        enabledBookings: 0,
        failed: 0,
      });
      expect(gateway.calls).toEqual([]);
    });

    it("skips calendars of users without the feature flags and marks them polled", async () => {
      disabledFlags.add(`1:${AUTO_JOIN_FLAG}`);
      disabledFlags.add(`2:${NOTETAKER_FLAG}`);
      addCalendar(1, [eventForUser(1)]);
      addCalendar(2, [eventForUser(2)]);
      addCalendar(3, [eventForUser(3)]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ calendarsPolled: 1, created: 1 });
      expect(gateway.calls).toEqual(["cal-3"]);
      expect(autoJoin.polled.map((p) => p.selectedCalendarId).sort()).toEqual(["cal-1", "cal-2", "cal-3"]);
      expect(autoJoin.polled.every((p) => p.error === null)).toBe(true);
    });

    it("only polls calendars that are due and of supported integrations", async () => {
      addCalendar(1, [eventForUser(1)], { lastPolledAt: new Date(NOW.getTime() - MINUTE_MS) });
      addCalendar(2, [eventForUser(2)], { lastPolledAt: new Date(NOW.getTime() - 10 * MINUTE_MS) });
      addCalendar(3, [eventForUser(3)], { integration: "office365_calendar" });

      const counts = await service.pollDue(NOW);

      expect(counts.calendarsPolled).toBe(1);
      expect(gateway.calls).toEqual(["cal-2"]);
    });

    it("records a failing calendar's error and still processes the others", async () => {
      addCalendar(1, async () => {
        throw new Error("Google 401");
      });
      addCalendar(2, [eventForUser(2)]);

      const counts = await service.pollDue(NOW);

      expect(counts).toMatchObject({ calendarsPolled: 2, created: 1, failed: 1 });
      expect(autoJoin.polledError("cal-1")).toBe("Google 401");
      expect(autoJoin.polledError("cal-2")).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        "Notetaker calendar sync failed",
        expect.objectContaining({ selectedCalendarId: "cal-1", userId: 1, error: "Google 401" })
      );
    });

    it("truncates long poll errors", async () => {
      addCalendar(1, async () => {
        throw new Error("x".repeat(600));
      });

      await service.pollDue(NOW);

      expect(autoJoin.polledError("cal-1")).toHaveLength(500);
    });

    it("fails a calendar whose user no longer exists", async () => {
      addCalendar(9, [eventForUser(9)]);

      const counts = await service.pollDue(NOW);

      expect(counts.failed).toBe(1);
      expect(autoJoin.polledError("cal-9")).toContain("User 9");
    });

    it("stops starting calendars once the time budget is spent", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const slow = async () => {
        vi.setSystemTime(new Date(Date.now() + 41_000));
        return [];
      };
      for (const userId of [1, 2, 3, 4, 5, 6, 7]) {
        addUser(userId);
        addCalendar(userId, slow);
      }

      const counts = await service.pollDue(NOW);

      expect(counts.calendarsPolled).toBe(5);
      expect(gateway.calls).toEqual(["cal-1", "cal-2", "cal-3", "cal-4", "cal-5"]);
      expect(autoJoin.polled).toHaveLength(5);
      expect(logger.warn).toHaveBeenCalledWith(
        "Notetaker calendar poll stopped at its time budget",
        expect.objectContaining({ polled: 5, remaining: 2 })
      );
    });
  });

  describe("syncCalendar", () => {
    it("rejects an integration without an events gateway", async () => {
      await expect(
        service.syncCalendar(buildCalendar(1, { integration: "office365_calendar" }), NOW)
      ).rejects.toThrow("No notetaker events gateway for integration office365_calendar");
    });
  });
});
