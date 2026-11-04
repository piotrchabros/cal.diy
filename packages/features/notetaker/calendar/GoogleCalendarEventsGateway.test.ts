import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { describe, expect, it } from "vitest";
import type {
  INotetakerGoogleEventsListClient,
  NotetakerGoogleEventsListParams,
} from "./GoogleCalendarEventsGateway";
import { GoogleCalendarEventsGateway } from "./GoogleCalendarEventsGateway";
import type { NotetakerAutoJoinCalendarRecord } from "./INotetakerCalendarEventsGateway";

type ListResponse = Awaited<ReturnType<INotetakerGoogleEventsListClient["events"]["list"]>>["data"];
type FakeEvent = NonNullable<ListResponse["items"]>[number];

const CALENDAR: NotetakerAutoJoinCalendarRecord = {
  selectedCalendarId: "sc-1",
  userId: 11,
  integration: "google_calendar",
  externalId: "owner@example.com",
  credentialId: 7,
  delegationCredentialId: null,
  sharingTeamId: null,
  lastPolledAt: null,
};
const TIME_MIN = new Date("2026-11-04T10:00:00.000Z");
const TIME_MAX = new Date("2026-11-05T10:00:00.000Z");
const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const TEAMS_LINK = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";

class FakeEventsListClient implements INotetakerGoogleEventsListClient {
  calls: NotetakerGoogleEventsListParams[] = [];

  constructor(private readonly pages: ListResponse[]) {}

  events = {
    list: async (params: NotetakerGoogleEventsListParams) => {
      this.calls.push(params);
      const page = this.pages[this.calls.length - 1] ?? {};
      return { data: page };
    },
  };
}

function timedEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    start: { dateTime: "2026-11-04T12:00:00Z" },
    end: { dateTime: "2026-11-04T13:00:00Z" },
    ...overrides,
  };
}

function buildGateway(client: INotetakerGoogleEventsListClient | null) {
  const requested: NotetakerAutoJoinCalendarRecord[] = [];
  const gateway = new GoogleCalendarEventsGateway({
    getEventsClient: async (calendar) => {
      requested.push(calendar);
      return client;
    },
  });
  return { gateway, requested };
}

async function listOne(event: FakeEvent) {
  const { gateway } = buildGateway(new FakeEventsListClient([{ items: [event] }]));
  const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });
  expect(events).toHaveLength(1);
  return events[0];
}

describe("GoogleCalendarEventsGateway", () => {
  describe("listEvents", () => {
    it("throws a NotFound ErrorWithCode naming the selected calendar when there is no client", async () => {
      const { gateway, requested } = buildGateway(null);

      const result = gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      await expect(result).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(result).rejects.toMatchObject({
        code: ErrorCode.NotFound,
        message: expect.stringContaining("sc-1"),
      });
      expect(requested).toEqual([CALENDAR]);
    });

    it("queries the calendar's externalId with single events, deleted instances and the field mask", async () => {
      const client = new FakeEventsListClient([{ items: [] }]);
      const { gateway } = buildGateway(client);

      await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]).toEqual({
        calendarId: "owner@example.com",
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: true,
        timeMin: "2026-11-04T10:00:00.000Z",
        timeMax: "2026-11-05T10:00:00.000Z",
        maxResults: 250,
        fields: expect.stringContaining("nextPageToken,items(id,iCalUID,status"),
      });
      expect(client.calls[0].fields).toContain("attendees(email,displayName,self,responseStatus,organizer)");
      expect(client.calls[0].fields).toContain("conferenceData/entryPoints");
    });

    it("follows nextPageToken until a page has none", async () => {
      const client = new FakeEventsListClient([
        { items: [timedEvent({ id: "a" })], nextPageToken: "p2" },
        { items: [timedEvent({ id: "b" })], nextPageToken: "p3" },
        { items: [timedEvent({ id: "c" })] },
      ]);
      const { gateway } = buildGateway(client);

      const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(events.map((event) => event.externalId)).toEqual(["a", "b", "c"]);
      expect(client.calls.map((call) => call.pageToken)).toEqual([undefined, "p2", "p3"]);
    });

    it("stops after ten pages even when Google keeps returning a page token", async () => {
      const pages = Array.from({ length: 12 }, (_, index) => ({
        items: [timedEvent({ id: `e${index}` })],
        nextPageToken: `p${index + 1}`,
      }));
      const client = new FakeEventsListClient(pages);
      const { gateway } = buildGateway(client);

      const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(client.calls).toHaveLength(10);
      expect(events).toHaveLength(10);
    });

    it("maps a timed event with a Meet link and other attendees", async () => {
      const event = await listOne(
        timedEvent({
          iCalUID: "ical-1@google.com",
          summary: "Planning",
          hangoutLink: MEET_LINK,
          conferenceData: { entryPoints: [{ entryPointType: "video", uri: MEET_LINK }] },
          organizer: { email: "Boss@Example.com" },
          attendees: [
            { email: "Owner@Example.com", self: true, responseStatus: "accepted" },
            {
              email: "Boss@Example.com",
              displayName: " Big Boss ",
              organizer: true,
              responseStatus: "accepted",
            },
          ],
        })
      );

      expect(event).toEqual({
        externalId: "evt-1",
        iCalUID: "ical-1@google.com",
        recurringEventId: null,
        title: "Planning",
        start: new Date("2026-11-04T12:00:00Z"),
        end: new Date("2026-11-04T13:00:00Z"),
        isAllDay: false,
        status: "confirmed",
        selfResponse: "accepted",
        organizerEmail: "boss@example.com",
        attendeeEmails: ["owner@example.com", "boss@example.com"],
        attendees: [
          { email: "owner@example.com", name: null },
          { email: "boss@example.com", name: "Big Boss" },
        ],
        candidateLinks: [MEET_LINK],
      });
    });

    it("leaves out attendees without an email and treats a blank display name as missing", async () => {
      const event = await listOne(
        timedEvent({
          attendees: [{ displayName: "No Email" }, { email: "guest@example.com", displayName: "   " }],
        })
      );

      expect(event.attendeeEmails).toEqual(["guest@example.com"]);
      expect(event.attendees).toEqual([{ email: "guest@example.com", name: null }]);
    });

    it("marks an event with a start date as all-day", async () => {
      const event = await listOne(timedEvent({ start: { date: "2026-11-04" }, end: { date: "2026-11-05" } }));

      expect(event.isAllDay).toBe(true);
      expect(event.start).toEqual(new Date("2026-11-04T00:00:00Z"));
    });

    it("reports the self attendee's decline", async () => {
      const event = await listOne(
        timedEvent({
          attendees: [
            { email: "owner@example.com", self: true, responseStatus: "declined" },
            { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
          ],
        })
      );

      expect(event.selfResponse).toBe("declined");
    });

    it("reports organizer when the user organizes, even without an attendee list", async () => {
      const event = await listOne(timedEvent({ organizer: { email: "owner@example.com", self: true } }));

      expect(event.selfResponse).toBe("organizer");
      expect(event.attendeeEmails).toEqual([]);
    });

    it("lets organizer win over a tentative self response but not over a decline", async () => {
      const tentative = await listOne(
        timedEvent({
          organizer: { email: "owner@example.com", self: true },
          attendees: [
            { email: "owner@example.com", self: true, organizer: true, responseStatus: "tentative" },
          ],
        })
      );
      const declined = await listOne(
        timedEvent({
          organizer: { email: "owner@example.com", self: true },
          attendees: [
            { email: "owner@example.com", self: true, organizer: true, responseStatus: "declined" },
          ],
        })
      );

      expect(tentative.selfResponse).toBe("organizer");
      expect(declined.selfResponse).toBe("declined");
    });

    it("returns null selfResponse when the user is not on the attendee list", async () => {
      const event = await listOne(timedEvent({ attendees: [{ email: "boss@example.com" }] }));

      expect(event.selfResponse).toBeNull();
    });

    it("extracts a Teams link from an HTML description after the location links", async () => {
      const event = await listOne(
        timedEvent({
          location: "Room 4, https://example.com/room-4",
          description: `<a href="${TEAMS_LINK}">Join the meeting now</a>`,
        })
      );

      expect(event.candidateLinks).toEqual(["https://example.com/room-4", TEAMS_LINK]);
    });

    it("orders links conference first and drops duplicates", async () => {
      const event = await listOne(
        timedEvent({
          hangoutLink: MEET_LINK,
          conferenceData: {
            entryPoints: [
              { entryPointType: "phone", uri: "tel:+1-555-0100" },
              { entryPointType: "video", uri: MEET_LINK },
            ],
          },
          location: MEET_LINK,
          description: `Join: ${MEET_LINK} or ${TEAMS_LINK}`,
        })
      );

      expect(event.candidateLinks).toEqual([MEET_LINK, TEAMS_LINK]);
    });

    it("maps a cancelled recurring instance that only carries originalStartTime", async () => {
      const event = await listOne({
        id: "evt-1_20261104T120000Z",
        status: "cancelled",
        recurringEventId: "evt-1",
        originalStartTime: { dateTime: "2026-11-04T12:00:00Z" },
      });

      expect(event).toMatchObject({
        externalId: "evt-1_20261104T120000Z",
        status: "cancelled",
        recurringEventId: "evt-1",
        start: new Date("2026-11-04T12:00:00Z"),
        end: new Date("2026-11-04T12:00:00Z"),
        isAllDay: false,
        candidateLinks: [],
      });
    });

    it("treats an unknown status as confirmed and keeps tentative", async () => {
      const unknown = await listOne(timedEvent({ status: null }));
      const tentative = await listOne(timedEvent({ status: "tentative" }));

      expect(unknown.status).toBe("confirmed");
      expect(tentative.status).toBe("tentative");
    });

    it("skips items without an id or any usable start time", async () => {
      const { gateway } = buildGateway(
        new FakeEventsListClient([
          {
            items: [
              timedEvent({ id: null }),
              { id: "no-time", status: "confirmed" },
              timedEvent({ id: "ok" }),
            ],
          },
        ])
      );

      const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(events.map((event) => event.externalId)).toEqual(["ok"]);
    });
  });
});
