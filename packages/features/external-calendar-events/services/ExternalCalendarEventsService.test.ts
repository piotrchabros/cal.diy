import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type {
  INotetakerCalendarEventsGateway,
  INotetakerCalendarEventsGatewayResolver,
} from "@calcom/features/notetaker/calendar/INotetakerCalendarEventsGateway";
import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";
import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalCalendarRef } from "../lib/externalCalendarEvents";
import { InMemoryExternalCalendarEventsCache } from "../lib/InMemoryExternalCalendarEventsCache";
import type {
  ExternalCalendarBookedLocation,
  ExternalCalendarBookingMatchKeys,
  ExternalCalendarMeetingEventKey,
  IExternalCalendarEventsRepository,
} from "../repositories/interfaces/IExternalCalendarEventsRepository";
import { ExternalCalendarEventsService } from "./ExternalCalendarEventsService";

const USER_ID = 7;
const USER_EMAIL = "Me@Example.com";
const FEATURE_SLUG = "bookings-external-calendar-events";
const GOOGLE = "google_calendar";
const OFFICE365 = "office365_calendar";
const FROM = new Date("2026-11-04T10:00:00.000Z");
const TO = new Date("2026-11-11T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MEET_URL = "https://meet.google.com/abc-defg-hij";

const GOOGLE_CALENDAR: ExternalCalendarRef = {
  selectedCalendarId: "sc-google",
  integration: GOOGLE,
  externalId: "me@gmail.com",
  credentialId: 5,
  delegationCredentialId: null,
};
const OFFICE_CALENDAR: ExternalCalendarRef = {
  selectedCalendarId: "sc-office",
  integration: OFFICE365,
  externalId: "me@outlook.com",
  credentialId: 6,
  delegationCredentialId: null,
};

function buildEvent(overrides: Partial<NotetakerCalendarEvent> = {}): NotetakerCalendarEvent {
  return {
    externalId: "ext-1",
    iCalUID: "ical-1",
    recurringEventId: null,
    title: "Standup",
    start: new Date(FROM.getTime() + HOUR_MS),
    end: new Date(FROM.getTime() + 2 * HOUR_MS),
    isAllDay: false,
    status: "confirmed",
    selfResponse: "accepted",
    organizerEmail: "boss@example.com",
    attendeeEmails: ["boss@example.com", "me@example.com"],
    candidateLinks: [],
    ...overrides,
  };
}

type GatewayBehaviour = (calendarId: string) => Promise<NotetakerCalendarEvent[]>;

class FakeRepository implements IExternalCalendarEventsRepository {
  calendars: ExternalCalendarRef[] = [];
  bookingKeys: ExternalCalendarBookingMatchKeys = { iCalUIDs: [], referenceUids: [] };
  participantKeys: ExternalCalendarMeetingEventKey[] = [];
  bookedLocations: ExternalCalendarBookedLocation[] = [];
  findUserLevelSelectedCalendarsByIntegrations = vi.fn(async (params: { integrations: string[] }) =>
    this.calendars.filter((calendar) => params.integrations.includes(calendar.integration))
  );
  findLiveBookingMatchKeysForUser = vi.fn(async () => this.bookingKeys);
  findActiveCalendarMeetingEventKeysByUserId = vi.fn(async () => this.participantKeys);
  findLiveBookingLocationsByUserIdInRange = vi.fn(async () => this.bookedLocations);
}

function buildService(
  options: { featureEnabled?: boolean; gateway?: GatewayBehaviour; integrations?: string[] } = {}
) {
  const repository = new FakeRepository();
  const listEvents = vi.fn(async ({ calendar }: { calendar: { selectedCalendarId: string } }) =>
    options.gateway ? options.gateway(calendar.selectedCalendarId) : []
  );
  const gateway: INotetakerCalendarEventsGateway = { listEvents };
  const integrations = options.integrations ?? [GOOGLE, OFFICE365];
  const eventsGatewayResolver: INotetakerCalendarEventsGatewayResolver = {
    resolve: (integration) => (integrations.includes(integration) ? gateway : null),
    supportedIntegrations: () => integrations,
  };
  const checkIfUserHasFeature = vi.fn(async (_userId: number, slug: string) =>
    slug === FEATURE_SLUG ? (options.featureEnabled ?? true) : false
  );
  const cache = new InMemoryExternalCalendarEventsCache({ maxEntries: 10 });
  const logger: ISimpleLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new ExternalCalendarEventsService({
    repository,
    eventsGatewayResolver,
    featuresRepository: { checkIfUserHasFeature },
    cache,
    logger,
  });
  return { service, repository, listEvents, cache, logger, checkIfUserHasFeature };
}

function list(service: ExternalCalendarEventsService, range: { from?: Date; to?: Date } = {}) {
  return service.list({
    userId: USER_ID,
    userEmail: USER_EMAIL,
    from: range.from ?? FROM,
    to: range.to ?? TO,
  });
}

describe("ExternalCalendarEventsService.list", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns unavailable without touching calendars when the flag is off", async () => {
    const { service, repository, checkIfUserHasFeature } = buildService({ featureEnabled: false });

    await expect(list(service)).resolves.toEqual({ available: false, events: [], failedCalendarCount: 0 });
    expect(checkIfUserHasFeature).toHaveBeenCalledWith(USER_ID, FEATURE_SLUG);
    expect(repository.findUserLevelSelectedCalendarsByIntegrations).not.toHaveBeenCalled();
  });

  it("rejects an empty or reversed range", async () => {
    const { service } = buildService();

    await expect(list(service, { from: FROM, to: FROM })).rejects.toMatchObject({
      code: ErrorWithCode.Factory.BadRequest().code,
      message: "INVALID_RANGE",
    });
    await expect(list(service, { from: TO, to: FROM })).rejects.toMatchObject({ message: "INVALID_RANGE" });
  });

  it("rejects a range longer than 8 days but accepts exactly 8 days", async () => {
    const { service } = buildService();

    await expect(
      list(service, { from: FROM, to: new Date(FROM.getTime() + 8 * DAY_MS + 1) })
    ).rejects.toMatchObject({
      message: "INVALID_RANGE",
    });
    await expect(list(service, { from: FROM, to: new Date(FROM.getTime() + 8 * DAY_MS) })).resolves.toEqual({
      available: true,
      events: [],
      failedCalendarCount: 0,
    });
  });

  it("loads only user-level calendars of the supported integrations", async () => {
    const { service, repository } = buildService({ integrations: [GOOGLE] });

    await list(service);

    expect(repository.findUserLevelSelectedCalendarsByIntegrations).toHaveBeenCalledWith({
      userId: USER_ID,
      integrations: [GOOGLE],
    });
  });

  it("calls the gateway with a record built from the calendar ref and the viewer", async () => {
    const { service, repository, listEvents } = buildService();
    repository.calendars = [GOOGLE_CALENDAR];

    await list(service);

    expect(listEvents).toHaveBeenCalledWith({
      calendar: {
        selectedCalendarId: "sc-google",
        userId: USER_ID,
        integration: GOOGLE,
        externalId: "me@gmail.com",
        credentialId: 5,
        delegationCredentialId: null,
        sharingTeamId: null,
        lastPolledAt: null,
      },
      timeMin: FROM,
      timeMax: TO,
    });
  });

  it("keeps the other calendars when one fails and counts the failure without logging event data", async () => {
    const { service, repository, logger } = buildService({
      gateway: async (calendarId) => {
        if (calendarId === "sc-google") throw new Error("boom");
        return [buildEvent({ externalId: "o-1", iCalUID: "ical-o-1", title: "Secret title" })];
      },
    });
    repository.calendars = [GOOGLE_CALENDAR, OFFICE_CALENDAR];

    const result = await list(service);

    expect(result.failedCalendarCount).toBe(1);
    expect(result.events.map((event) => event.key)).toEqual(["sc-office:o-1"]);
    expect(logger.warn).toHaveBeenCalledWith("External calendar events fetch failed", {
      selectedCalendarId: "sc-google",
      integration: GOOGLE,
      message: "boom",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Secret title");
  });

  it("counts a provider call that exceeds the 8s timeout as a failed calendar", async () => {
    vi.useFakeTimers();
    const { service, repository } = buildService({ gateway: () => new Promise(() => undefined) });
    repository.calendars = [GOOGLE_CALENDAR];

    const pending = list(service);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual({ available: true, events: [], failedCalendarCount: 1 });
  });

  it("serves a second call for the same calendar and window from the cache", async () => {
    const { service, repository, listEvents } = buildService({ gateway: async () => [buildEvent()] });
    repository.calendars = [GOOGLE_CALENDAR];

    const first = await list(service);
    const second = await list(service);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(second.events).toEqual(first.events);
    expect(repository.findLiveBookingMatchKeysForUser).toHaveBeenCalledTimes(2);
  });

  it("does not reuse the cache for a different window", async () => {
    const { service, repository, listEvents } = buildService({ gateway: async () => [buildEvent()] });
    repository.calendars = [GOOGLE_CALENDAR];

    await list(service);
    await list(service, { from: FROM, to: new Date(TO.getTime() - HOUR_MS) });

    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it("skips a calendar whose integration has no gateway without counting it as failed", async () => {
    const { service, repository, listEvents } = buildService({ gateway: async () => [buildEvent()] });
    repository.calendars = [GOOGLE_CALENDAR, { ...OFFICE_CALENDAR, integration: "caldav_calendar" }];
    repository.findUserLevelSelectedCalendarsByIntegrations.mockImplementation(
      async () => repository.calendars
    );

    const result = await list(service);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      available: true,
      failedCalendarCount: 0,
      events: [expect.objectContaining({ key: "sc-google:ext-1" })],
    });
  });

  it("drops cancelled and declined events and the same event seen through two calendars", async () => {
    const { service, repository } = buildService({
      gateway: async (calendarId) =>
        calendarId === "sc-google"
          ? [
              buildEvent({ externalId: "g-1", iCalUID: "shared" }),
              buildEvent({ externalId: "g-2", iCalUID: "ical-2", status: "cancelled" }),
              buildEvent({ externalId: "g-3", iCalUID: "ical-3", selfResponse: "declined" }),
            ]
          : [buildEvent({ externalId: "o-1", iCalUID: "shared" })],
    });
    repository.calendars = [GOOGLE_CALENDAR, OFFICE_CALENDAR];

    const result = await list(service);

    expect(result.events.map((event) => event.key)).toEqual(["sc-google:g-1"]);
  });

  it("queries Cal.diy matches with the keys of the visible events only", async () => {
    const { service, repository } = buildService({
      gateway: async () => [
        buildEvent({
          externalId: "g-1",
          iCalUID: "ical-1",
          recurringEventId: "rec-1",
          candidateLinks: [MEET_URL],
        }),
        buildEvent({ externalId: "g-2", iCalUID: null, status: "cancelled" }),
      ],
    });
    repository.calendars = [GOOGLE_CALENDAR];

    await list(service);

    expect(repository.findLiveBookingMatchKeysForUser).toHaveBeenCalledWith({
      userId: USER_ID,
      userEmail: USER_EMAIL,
      iCalUIDs: ["ical-1"],
      referenceUids: ["g-1", "rec-1"],
    });
    expect(repository.findActiveCalendarMeetingEventKeysByUserId).toHaveBeenCalledWith({
      userId: USER_ID,
      selectedCalendarIds: ["sc-google"],
    });
    expect(repository.findLiveBookingLocationsByUserIdInRange).toHaveBeenCalledWith({
      userId: USER_ID,
      locations: [MEET_URL],
      from: FROM,
      to: TO,
    });
  });

  it("skips the Cal.diy lookups when no event is visible", async () => {
    const { service, repository } = buildService({
      gateway: async () => [buildEvent({ status: "cancelled" })],
    });
    repository.calendars = [GOOGLE_CALENDAR];

    await expect(list(service)).resolves.toEqual({ available: true, events: [], failedCalendarCount: 0 });
    expect(repository.findLiveBookingMatchKeysForUser).not.toHaveBeenCalled();
    expect(repository.findActiveCalendarMeetingEventKeysByUserId).not.toHaveBeenCalled();
    expect(repository.findLiveBookingLocationsByUserIdInRange).not.toHaveBeenCalled();
  });

  describe("hides events already represented in Cal.diy", () => {
    const start = new Date(FROM.getTime() + HOUR_MS);
    const end = new Date(FROM.getTime() + 2 * HOUR_MS);

    function buildMatchingService() {
      const built = buildService({
        gateway: async () => [
          buildEvent({ externalId: "by-ical", iCalUID: "ical-match" }),
          buildEvent({ externalId: "by-ref", iCalUID: "ical-2" }),
          buildEvent({ externalId: "inst-1", iCalUID: "ical-3", recurringEventId: "rec-match" }),
          buildEvent({ externalId: "by-participant", iCalUID: "ical-4" }),
          buildEvent({ externalId: "by-location", iCalUID: "ical-5", candidateLinks: [MEET_URL] }),
          buildEvent({
            externalId: "by-location-other-time",
            iCalUID: "ical-6",
            candidateLinks: [MEET_URL],
            start: new Date(start.getTime() + DAY_MS),
            end: new Date(end.getTime() + DAY_MS),
          }),
          buildEvent({ externalId: "kept", iCalUID: "ical-7" }),
        ],
      });
      built.repository.calendars = [GOOGLE_CALENDAR];
      return built;
    }

    it("by booking iCalUID", async () => {
      const { service, repository } = buildMatchingService();
      repository.bookingKeys = { iCalUIDs: ["ical-match"], referenceUids: [] };

      const result = await list(service);

      expect(result.events.map((event) => event.key)).not.toContain("sc-google:by-ical");
      expect(result.events.map((event) => event.key)).toContain("sc-google:kept");
    });

    it("by booking reference uid, including the recurring master id", async () => {
      const { service, repository } = buildMatchingService();
      repository.bookingKeys = { iCalUIDs: [], referenceUids: ["by-ref", "rec-match"] };

      const keys = (await list(service)).events.map((event) => event.key);

      expect(keys).not.toContain("sc-google:by-ref");
      expect(keys).not.toContain("sc-google:inst-1");
      expect(keys).toContain("sc-google:kept");
    });

    it("by active calendar meeting participation", async () => {
      const { service, repository } = buildMatchingService();
      repository.participantKeys = [{ selectedCalendarId: "sc-google", externalEventId: "by-participant" }];

      const keys = (await list(service)).events.map((event) => event.key);

      expect(keys).not.toContain("sc-google:by-participant");
      expect(keys).toContain("sc-google:kept");
    });

    it("by an overlapping booking at the same meeting url only", async () => {
      const { service, repository } = buildMatchingService();
      repository.bookedLocations = [{ location: MEET_URL, startTime: start, endTime: end }];

      const keys = (await list(service)).events.map((event) => event.key);

      expect(keys).not.toContain("sc-google:by-location");
      expect(keys).toContain("sc-google:by-location-other-time");
      expect(keys).toContain("sc-google:kept");
    });

    it("keeps everything when nothing matches", async () => {
      const { service } = buildMatchingService();

      expect((await list(service)).events).toHaveLength(7);
    });
  });

  it("maps events to DTOs without attendee emails and sorts by start then title", async () => {
    const { service, repository } = buildService({
      gateway: async () => [
        buildEvent({
          externalId: "late",
          iCalUID: "i-late",
          title: "Late",
          start: new Date(FROM.getTime() + 3 * HOUR_MS),
          end: new Date(FROM.getTime() + 4 * HOUR_MS),
        }),
        buildEvent({
          externalId: "b",
          iCalUID: "i-b",
          title: "Bravo",
          candidateLinks: ["https://example.com", MEET_URL],
        }),
        buildEvent({
          externalId: "a",
          iCalUID: "i-a",
          title: "Alpha",
          status: "tentative",
          selfResponse: "needsAction",
        }),
        buildEvent({ externalId: "untitled", iCalUID: "i-u", title: null, isAllDay: true }),
      ],
    });
    repository.calendars = [GOOGLE_CALENDAR];

    const { events } = await list(service);

    expect(events.map((event) => event.key)).toEqual([
      "sc-google:untitled",
      "sc-google:a",
      "sc-google:b",
      "sc-google:late",
    ]);
    expect(events[2]).toEqual({
      key: "sc-google:b",
      title: "Bravo",
      start: new Date(FROM.getTime() + HOUR_MS),
      end: new Date(FROM.getTime() + 2 * HOUR_MS),
      isAllDay: false,
      status: "confirmed",
      selfResponse: "accepted",
      attendeesCount: 2,
      meetingUrl: MEET_URL,
      meetingPlatform: "GOOGLE_MEET",
      calendar: { selectedCalendarId: "sc-google", integration: GOOGLE, externalId: "me@gmail.com" },
    });
    expect(events[1]).toMatchObject({ status: "tentative", selfResponse: "needsAction", meetingUrl: null });
    expect(events[0]).toMatchObject({ title: null, isAllDay: true });
    expect(JSON.stringify(events)).not.toContain("boss@example.com");
  });
});
