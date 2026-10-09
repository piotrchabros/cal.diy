import { describe, expect, it } from "vitest";
import type { INotetakerGoogleEventsClient } from "./GoogleCalendarGuestGateway";
import { GoogleCalendarGuestGateway, isSameMeetingLink } from "./GoogleCalendarGuestGateway";
import type { NotetakerCalendarEventRef } from "./INotetakerCalendarGuestGateway";

const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const GUEST_EMAIL = "notetaker@example.com";
const CALENDAR_ID = "team@example.com";
const EVENT_ID = "evt-1";

const EVENT_REF: NotetakerCalendarEventRef = { credentialId: 7, eventId: EVENT_ID, calendarId: CALENDAR_ID };

type GetParams = Parameters<INotetakerGoogleEventsClient["events"]["get"]>[0];
type PatchParams = Parameters<INotetakerGoogleEventsClient["events"]["patch"]>[0];
type FakeEvent = Awaited<ReturnType<INotetakerGoogleEventsClient["events"]["get"]>>["data"];

class RecordingEventsClient implements INotetakerGoogleEventsClient {
  getCalls: GetParams[] = [];
  patchCalls: PatchParams[] = [];
  event: FakeEvent = { hangoutLink: MEET_LINK, attendees: [] };
  getError: Error | null = null;
  patchError: Error | null = null;

  events = {
    get: async (params: GetParams) => {
      this.getCalls.push(params);
      if (this.getError) throw this.getError;
      return { data: this.event };
    },
    patch: async (params: PatchParams) => {
      this.patchCalls.push(params);
      if (this.patchError) throw this.patchError;
      return {};
    },
  };
}

function buildClient(event: FakeEvent = { hangoutLink: MEET_LINK, attendees: [] }): RecordingEventsClient {
  const client = new RecordingEventsClient();
  client.event = event;
  return client;
}

function buildGateway(client: INotetakerGoogleEventsClient | null, clientError?: Error) {
  const credentialIds: number[] = [];
  const gateway = new GoogleCalendarGuestGateway({
    getEventsClient: async (credentialId) => {
      credentialIds.push(credentialId);
      if (clientError) throw clientError;
      return client;
    },
  });
  return { gateway, credentialIds };
}

function ensure(
  client: INotetakerGoogleEventsClient | null,
  overrides: { event?: NotetakerCalendarEventRef; guestEmail?: string; meetingUrl?: string } = {}
) {
  const { gateway } = buildGateway(client);
  return gateway.ensureGuest({
    event: overrides.event ?? EVENT_REF,
    guestEmail: overrides.guestEmail ?? GUEST_EMAIL,
    meetingUrl: overrides.meetingUrl ?? MEET_LINK,
  });
}

describe("GoogleCalendarGuestGateway", () => {
  describe("ensureGuest", () => {
    it("returns CREDENTIAL_UNAVAILABLE when there is no events client for the credential", async () => {
      const { gateway, credentialIds } = buildGateway(null);

      const outcome = await gateway.ensureGuest({
        event: EVENT_REF,
        guestEmail: GUEST_EMAIL,
        meetingUrl: MEET_LINK,
      });

      expect(outcome).toBe("CREDENTIAL_UNAVAILABLE");
      expect(credentialIds).toEqual([EVENT_REF.credentialId]);
    });

    it("reads the event with the given calendar and event ids", async () => {
      const client = buildClient();

      await ensure(client);

      expect(client.getCalls).toEqual([{ calendarId: CALENDAR_ID, eventId: EVENT_ID }]);
    });

    it("uses the primary calendar when calendarId is null", async () => {
      const client = buildClient();

      const outcome = await ensure(client, { event: { ...EVENT_REF, calendarId: null } });

      expect(outcome).toBe("ADDED");
      expect(client.getCalls).toEqual([{ calendarId: "primary", eventId: EVENT_ID }]);
      expect(client.patchCalls).toHaveLength(1);
      expect(client.patchCalls[0].calendarId).toBe("primary");
    });

    it.each<{ name: string; event: FakeEvent }>([
      { name: "the event is cancelled", event: { status: "cancelled", hangoutLink: MEET_LINK } },
      { name: "the event has no hangoutLink", event: { attendees: [] } },
      { name: "the hangoutLink is null", event: { hangoutLink: null, attendees: [] } },
      {
        name: "the hangoutLink has a different meeting code",
        event: { hangoutLink: "https://meet.google.com/xyz-defg-hij", attendees: [] },
      },
    ])("returns NOT_THE_MEETING_EVENT without writing when $name", async ({ event }) => {
      const client = buildClient(event);

      const outcome = await ensure(client);

      expect(outcome).toBe("NOT_THE_MEETING_EVENT");
      expect(client.patchCalls).toEqual([]);
    });

    it("returns NOT_THE_MEETING_EVENT without writing when the guest list is omitted", async () => {
      const client = buildClient({ hangoutLink: MEET_LINK, attendeesOmitted: true, attendees: [] });

      const outcome = await ensure(client);

      expect(outcome).toBe("NOT_THE_MEETING_EVENT");
      expect(client.patchCalls).toEqual([]);
    });

    it("compares the meeting link loosely instead of by string equality", async () => {
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [] });

      const outcome = await ensure(client, {
        meetingUrl: "https://MEET.google.com/abc-defg-hij/?authuser=1",
      });

      expect(outcome).toBe("ADDED");
    });

    it("returns ALREADY_PRESENT without writing when the guest is listed with the same email", async () => {
      const listedGuest = { email: GUEST_EMAIL };
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [listedGuest] });

      const outcome = await ensure(client);

      expect(outcome).toBe("ALREADY_PRESENT");
      expect(client.patchCalls).toEqual([]);
    });

    it("matches an existing guest case-insensitively and ignores surrounding whitespace", async () => {
      const listedGuest = { email: "  Notetaker@Example.COM " };
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [listedGuest] });

      const outcome = await ensure(client, { guestEmail: "notetaker@example.com" });

      expect(outcome).toBe("ALREADY_PRESENT");
      expect(client.patchCalls).toEqual([]);
    });

    it("matches when the existing email is lower case and guestEmail is mixed case", async () => {
      const listedGuest = { email: "notetaker@example.com" };
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [listedGuest] });

      const outcome = await ensure(client, { guestEmail: "NoteTaker@Example.com" });

      expect(outcome).toBe("ALREADY_PRESENT");
      expect(client.patchCalls).toEqual([]);
    });

    it("patches the event with the untouched existing guests plus the new one", async () => {
      const organizerGuest = {
        email: "host@example.com",
        displayName: "Host",
        organizer: true,
        self: true,
        responseStatus: "accepted",
      };
      const otherGuest = {
        email: "guest@example.com",
        displayName: "Guest",
        optional: true,
        comment: "Might be late",
        responseStatus: "tentative",
      };
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [organizerGuest, otherGuest] });

      const outcome = await ensure(client);

      expect(outcome).toBe("ADDED");
      expect(client.patchCalls).toHaveLength(1);
      expect(client.patchCalls[0]).toEqual({
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        sendUpdates: "none",
        requestBody: { attendees: [organizerGuest, otherGuest, { email: GUEST_EMAIL }] },
      });
      const { attendees } = client.patchCalls[0].requestBody;
      expect(attendees).toHaveLength(3);
      expect(attendees[0]).toBe(organizerGuest);
      expect(attendees[1]).toBe(otherGuest);
      expect(attendees[2]).toStrictEqual({ email: GUEST_EMAIL });
      expect(organizerGuest).toEqual({
        email: "host@example.com",
        displayName: "Host",
        organizer: true,
        self: true,
        responseStatus: "accepted",
      });
    });

    it.each<{ name: string; attendees: undefined | null }>([
      { name: "undefined", attendees: undefined },
      { name: "null", attendees: null },
    ])("sends only the new guest when attendees is $name", async ({ attendees }) => {
      const client = buildClient({ hangoutLink: MEET_LINK, attendees });

      const outcome = await ensure(client);

      expect(outcome).toBe("ADDED");
      expect(client.patchCalls[0].requestBody.attendees).toEqual([{ email: GUEST_EMAIL }]);
    });

    it("keeps a guest without an address by identity and does not treat it as a match", async () => {
      const addresslessGuest = { email: null, displayName: "Conference room", resource: true };
      const client = buildClient({ hangoutLink: MEET_LINK, attendees: [addresslessGuest] });

      const outcome = await ensure(client);

      expect(outcome).toBe("ADDED");
      const { attendees } = client.patchCalls[0].requestBody;
      expect(attendees).toHaveLength(2);
      expect(attendees[0]).toBe(addresslessGuest);
    });

    it("adds the new guest with guestEmail exactly as given", async () => {
      const client = buildClient();

      await ensure(client, { guestEmail: "NoteTaker@Example.com" });

      expect(client.patchCalls[0].requestBody.attendees).toStrictEqual([{ email: "NoteTaker@Example.com" }]);
    });

    it("rejects with the same error when getEventsClient rejects", async () => {
      const client = buildClient();
      const error = new Error("credential lookup failed");
      const { gateway } = buildGateway(client, error);

      await expect(
        gateway.ensureGuest({ event: EVENT_REF, guestEmail: GUEST_EMAIL, meetingUrl: MEET_LINK })
      ).rejects.toBe(error);
      expect(client.getCalls).toEqual([]);
    });

    it("rejects with the same error when reading the event fails and does not patch", async () => {
      const client = buildClient();
      const error = new Error("get failed");
      client.getError = error;

      await expect(ensure(client)).rejects.toBe(error);
      expect(client.patchCalls).toEqual([]);
    });

    it("rejects with the same error when patching the event fails", async () => {
      const client = buildClient();
      const error = new Error("patch failed");
      client.patchError = error;

      await expect(ensure(client)).rejects.toBe(error);
      expect(client.patchCalls).toHaveLength(1);
    });
  });
});

describe("isSameMeetingLink", () => {
  it.each<{ name: string; a: string; b: string; expected: boolean }>([
    { name: "identical links", a: MEET_LINK, b: MEET_LINK, expected: true },
    { name: "a query string is ignored", a: MEET_LINK, b: `${MEET_LINK}?authuser=1`, expected: true },
    { name: "a trailing slash is ignored", a: MEET_LINK, b: `${MEET_LINK}/`, expected: true },
    {
      name: "the host is case-insensitive",
      a: MEET_LINK,
      b: "https://MEET.GOOGLE.COM/abc-defg-hij",
      expected: true,
    },
    { name: "a fragment is ignored", a: MEET_LINK, b: `${MEET_LINK}#frag`, expected: true },
    {
      name: "the path is case-insensitive",
      a: MEET_LINK,
      b: "https://meet.google.com/ABC-DEFG-HIJ",
      expected: true,
    },
    {
      name: "a different meeting code",
      a: MEET_LINK,
      b: "https://meet.google.com/xyz-defg-hij",
      expected: false,
    },
    {
      name: "a different host",
      a: MEET_LINK,
      b: "https://meet.example.com/abc-defg-hij",
      expected: false,
    },
    { name: "one side is not a URL", a: MEET_LINK, b: "not a url", expected: false },
    { name: "both sides are not a URL", a: "not a url", b: "not a url", expected: false },
    { name: "both sides are empty", a: "", b: "", expected: false },
    {
      name: "both sides are not http(s)",
      a: "mailto:a@example.com",
      b: "mailto:a@example.com",
      expected: false,
    },
    {
      name: "http and https links to the same meeting",
      a: "http://meet.google.com/abc-defg-hij",
      b: MEET_LINK,
      expected: true,
    },
  ])("returns $expected when $name", ({ a, b, expected }) => {
    expect(isSameMeetingLink(a, b)).toBe(expected);
  });
});
