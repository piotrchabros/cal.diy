import type { CredentialForCalendarServiceWithTenantId } from "@calcom/types/Credential";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createOffice365CalendarServiceWithEventsReader } from "./CalendarService";

const mockRequestRaw = vi.fn();
vi.mock("../../_utils/oauth/OAuthManager", () => ({
  OAuthManager: vi.fn().mockImplementation(function () {
    return { requestRaw: mockRequestRaw };
  }),
}));

const testCredential: CredentialForCalendarServiceWithTenantId = {
  appId: "office365-calendar",
  id: 1,
  invalid: false,
  key: { access_token: "token", refresh_token: "refresh", expiry_date: 1625097600000 },
  type: "office365_calendar",
  userId: 1,
  user: { email: "owner@example.com" },
  teamId: null,
  delegatedTo: null,
  delegationCredentialId: null,
  encryptedKey: null,
};

const TIME_MIN = new Date("2026-11-04T10:00:00.000Z");
const TIME_MAX = new Date("2026-11-05T10:00:00.000Z");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestedUrl(callIndex: number): string {
  return mockRequestRaw.mock.calls[callIndex][0].url;
}

describe("Office365CalendarService.listEventsWithMeetingDetails", () => {
  beforeEach(() => {
    mockRequestRaw.mockReset();
  });

  test("requests the calendar view of the calendar in UTC with plain-text bodies", async () => {
    mockRequestRaw.mockResolvedValueOnce(jsonResponse({ value: [{ id: "evt-1" }] }));
    const service = createOffice365CalendarServiceWithEventsReader(testCredential);

    const events = await service.listEventsWithMeetingDetails({
      calendarId: "cal-1",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(events).toEqual([{ id: "evt-1" }]);
    expect(mockRequestRaw).toHaveBeenCalledTimes(1);
    const url = new URL(requestedUrl(0));
    expect(url.origin + url.pathname).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView"
    );
    expect(url.searchParams.get("startDateTime")).toBe("2026-11-04T10:00:00.000Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-11-05T10:00:00.000Z");
    expect(url.searchParams.get("$top")).toBe("100");
    expect(url.searchParams.get("$select")?.split(",")).toEqual(
      expect.arrayContaining(["iCalUId", "responseStatus", "onlineMeeting", "body", "seriesMasterId"])
    );
    expect(mockRequestRaw.mock.calls[0][0].options.headers).toEqual({
      Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
    });
  });

  test("follows @odata.nextLink relative to the Graph base URL until a page has none", async () => {
    mockRequestRaw
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: "a" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skip=100",
        })
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "b" }] }));
    const service = createOffice365CalendarServiceWithEventsReader(testCredential);

    const events = await service.listEventsWithMeetingDetails({
      calendarId: "cal-1",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(events.map((event) => event.id)).toEqual(["a", "b"]);
    expect(requestedUrl(1)).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skip=100"
    );
  });

  test("stops after ten pages even when Graph keeps returning a nextLink", async () => {
    let page = 0;
    mockRequestRaw.mockImplementation(async () => {
      page++;
      return jsonResponse({
        value: [{ id: `e${page}` }],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skip=${page}`,
      });
    });
    const service = createOffice365CalendarServiceWithEventsReader(testCredential);

    const events = await service.listEventsWithMeetingDetails({
      calendarId: "cal-1",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
    });

    expect(mockRequestRaw).toHaveBeenCalledTimes(10);
    expect(events).toHaveLength(10);
  });

  test("rejects when Graph answers with an error status", async () => {
    mockRequestRaw.mockResolvedValueOnce(jsonResponse({ error: { code: "ErrorItemNotFound" } }, 404));
    const service = createOffice365CalendarServiceWithEventsReader(testCredential);

    await expect(
      service.listEventsWithMeetingDetails({ calendarId: "cal-1", timeMin: TIME_MIN, timeMax: TIME_MAX })
    ).rejects.toThrow();
  });
});
