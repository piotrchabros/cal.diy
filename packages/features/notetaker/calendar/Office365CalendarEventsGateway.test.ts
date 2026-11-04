import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { describe, expect, it } from "vitest";
import type { NotetakerAutoJoinCalendarRecord } from "./INotetakerCalendarEventsGateway";
import type { INotetakerOffice365EventsReader } from "./Office365CalendarEventsGateway";
import { Office365CalendarEventsGateway } from "./Office365CalendarEventsGateway";

type ListParams = Parameters<INotetakerOffice365EventsReader["listEventsWithMeetingDetails"]>[0];
type FakeEvent = Awaited<ReturnType<INotetakerOffice365EventsReader["listEventsWithMeetingDetails"]>>[number];

const CALENDAR: NotetakerAutoJoinCalendarRecord = {
  selectedCalendarId: "sc-1",
  userId: 11,
  integration: "office365_calendar",
  externalId: "AAMkAGI2-calendar-id=",
  credentialId: 7,
  delegationCredentialId: null,
  sharingTeamId: null,
  lastPolledAt: null,
};
const TIME_MIN = new Date("2026-11-04T10:00:00.000Z");
const TIME_MAX = new Date("2026-11-05T10:00:00.000Z");
const TEAMS_LINK = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0";
const ZOOM_LINK = "https://us02web.zoom.us/j/1234567890";

class FakeEventsReader implements INotetakerOffice365EventsReader {
  calls: ListParams[] = [];

  constructor(private readonly items: FakeEvent[]) {}

  async listEventsWithMeetingDetails(params: ListParams) {
    this.calls.push(params);
    return this.items;
  }
}

function timedEvent(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: "evt-1",
    start: { dateTime: "2026-11-04T12:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-04T13:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    ...overrides,
  };
}

function buildGateway(reader: INotetakerOffice365EventsReader | null) {
  const requested: NotetakerAutoJoinCalendarRecord[] = [];
  const gateway = new Office365CalendarEventsGateway({
    getEventsReader: async (calendar) => {
      requested.push(calendar);
      return reader;
    },
  });
  return { gateway, requested };
}

async function listOne(event: FakeEvent) {
  const { gateway } = buildGateway(new FakeEventsReader([event]));
  const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });
  expect(events).toHaveLength(1);
  return events[0];
}

describe("Office365CalendarEventsGateway", () => {
  describe("listEvents", () => {
    it("throws a NotFound ErrorWithCode naming the selected calendar when there is no reader", async () => {
      const { gateway, requested } = buildGateway(null);

      const result = gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      await expect(result).rejects.toBeInstanceOf(ErrorWithCode);
      await expect(result).rejects.toMatchObject({
        code: ErrorCode.NotFound,
        message: expect.stringContaining("sc-1"),
      });
      expect(requested).toEqual([CALENDAR]);
    });

    it("lists the calendar's externalId over the requested window", async () => {
      const reader = new FakeEventsReader([]);
      const { gateway } = buildGateway(reader);

      await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(reader.calls).toEqual([
        { calendarId: "AAMkAGI2-calendar-id=", timeMin: TIME_MIN, timeMax: TIME_MAX },
      ]);
    });

    it("propagates a reader failure", async () => {
      const gateway = new Office365CalendarEventsGateway({
        getEventsReader: async () => ({
          listEventsWithMeetingDetails: async () => {
            throw new Error("Graph unavailable");
          },
        }),
      });

      await expect(
        gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX })
      ).rejects.toThrow("Graph unavailable");
    });

    it("maps an accepted Teams meeting with other attendees", async () => {
      const event = await listOne(
        timedEvent({
          iCalUId: "040000008200E00074C5B7101A82E008",
          subject: "Planning",
          responseStatus: { response: "accepted" },
          isOrganizer: false,
          onlineMeeting: { joinUrl: TEAMS_LINK },
          organizer: { emailAddress: { address: "Boss@Example.com" } },
          attendees: [
            { emailAddress: { address: "Owner@Example.com" } },
            { emailAddress: { address: "boss@example.com" } },
            { emailAddress: { address: null } },
          ],
        })
      );

      expect(event).toEqual({
        externalId: "evt-1",
        iCalUID: "040000008200E00074C5B7101A82E008",
        recurringEventId: null,
        title: "Planning",
        start: new Date("2026-11-04T12:00:00Z"),
        end: new Date("2026-11-04T13:00:00Z"),
        isAllDay: false,
        status: "confirmed",
        selfResponse: "accepted",
        organizerEmail: "boss@example.com",
        attendeeEmails: ["owner@example.com", "boss@example.com"],
        candidateLinks: [TEAMS_LINK],
      });
    });

    it("maps each Graph response to the notetaker self response", async () => {
      const responses = [
        ["accepted", "accepted"],
        ["tentativelyAccepted", "tentative"],
        ["declined", "declined"],
        ["organizer", "organizer"],
        ["notResponded", "needsAction"],
        ["none", "needsAction"],
        [undefined, null],
      ] as const;

      for (const [response, expected] of responses) {
        const event = await listOne(timedEvent({ responseStatus: response ? { response } : null }));
        expect(event.selfResponse).toBe(expected);
      }
    });

    it("reports organizer when Graph flags the user as organizer whatever the response says", async () => {
      const event = await listOne(timedEvent({ isOrganizer: true, responseStatus: { response: "none" } }));

      expect(event.selfResponse).toBe("organizer");
    });

    it("keeps a decline even when the user organizes the event", async () => {
      const event = await listOne(
        timedEvent({ isOrganizer: true, responseStatus: { response: "declined" } })
      );

      expect(event.selfResponse).toBe("declined");
    });

    it("marks all-day and cancelled events", async () => {
      const allDay = await listOne(
        timedEvent({
          isAllDay: true,
          start: { dateTime: "2026-11-04T00:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-05T00:00:00.0000000", timeZone: "UTC" },
        })
      );
      const cancelled = await listOne(timedEvent({ isCancelled: true, seriesMasterId: "series-1" }));

      expect(allDay.isAllDay).toBe(true);
      expect(allDay.start).toEqual(new Date("2026-11-04T00:00:00Z"));
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.recurringEventId).toBe("series-1");
    });

    it("honours an explicit offset on dateTime", async () => {
      const event = await listOne(timedEvent({ start: { dateTime: "2026-11-04T13:00:00+01:00" } }));

      expect(event.start).toEqual(new Date("2026-11-04T12:00:00Z"));
    });

    it("orders links online meeting first, then location, then body, and drops duplicates", async () => {
      const event = await listOne(
        timedEvent({
          onlineMeeting: { joinUrl: TEAMS_LINK },
          onlineMeetingUrl: TEAMS_LINK,
          location: { displayName: `Zoom ${ZOOM_LINK}`, locationUri: "Room 4" },
          body: { content: `Join here: ${TEAMS_LINK} or https://example.com/agenda.` },
          bodyPreview: "Join here",
        })
      );

      expect(event.candidateLinks).toEqual([TEAMS_LINK, ZOOM_LINK, "https://example.com/agenda"]);
    });

    it("finds a link in the body when the event is not an online meeting", async () => {
      const event = await listOne(timedEvent({ body: { content: `Dial in at ${ZOOM_LINK}` } }));

      expect(event.candidateLinks).toEqual([ZOOM_LINK]);
    });

    it("falls back to bodyPreview when the body content is empty", async () => {
      const event = await listOne(timedEvent({ body: { content: "" }, bodyPreview: `Join ${ZOOM_LINK}` }));

      expect(event.candidateLinks).toEqual([ZOOM_LINK]);
    });

    it("skips items without an id or a usable start time", async () => {
      const { gateway } = buildGateway(
        new FakeEventsReader([
          timedEvent({ id: null }),
          timedEvent({ id: "no-time", start: null }),
          timedEvent({ id: "bad-time", start: { dateTime: "not a date" } }),
          timedEvent({ id: "ok" }),
        ])
      );

      const events = await gateway.listEvents({ calendar: CALENDAR, timeMin: TIME_MIN, timeMax: TIME_MAX });

      expect(events.map((event) => event.externalId)).toEqual(["ok"]);
    });
  });
});
