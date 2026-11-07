import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import AttendeeDailyVideoDownloadRecordingEmail from "./attendee-daily-video-download-recording-email";
import AttendeeDailyVideoDownloadTranscriptEmail from "./attendee-daily-video-download-transcript-email";
import OrganizerDailyVideoDownloadRecordingEmail from "./organizer-daily-video-download-recording-email";
import OrganizerDailyVideoDownloadTranscriptEmail from "./organizer-daily-video-download-transcript-email";

const ORG_URL = "https://org.example.com";

const translate = ((key: string) => key) as unknown as TFunction;

const organizer: Person = {
  name: "Host",
  email: "host@example.com",
  timeZone: "UTC",
  language: { translate, locale: "en" },
};
const attendee: Person = { ...organizer, name: "Guest", email: "guest@example.com" };

const buildEvent = (bookerUrl?: string): CalendarEvent => ({
  type: "Intro",
  title: "Intro call",
  startTime: "2026-11-10T10:00:00.000Z",
  endTime: "2026-11-10T10:30:00.000Z",
  organizer,
  attendees: [attendee],
  uid: "booking-uid",
  bookerUrl,
});

type EmailWithPayload = { getNodeMailerPayload(): Promise<Record<string, unknown>> };

const html = async (email: unknown) => {
  const payload = await (email as EmailWithPayload).getNodeMailerPayload();
  return String(payload.html);
};

const emails = (calEvent: CalendarEvent) => [
  new OrganizerDailyVideoDownloadRecordingEmail(calEvent, "https://download.example/rec"),
  new AttendeeDailyVideoDownloadRecordingEmail(calEvent, attendee, "https://download.example/rec"),
  new OrganizerDailyVideoDownloadTranscriptEmail(calEvent, []),
  new AttendeeDailyVideoDownloadTranscriptEmail(calEvent, attendee, []),
];

describe("daily video download emails", () => {
  it("link the logo to the organizer's base URL", async () => {
    for (const email of emails(buildEvent(ORG_URL))) {
      expect(await html(email)).toContain(`href="${ORG_URL}"`);
    }
  });

  it("fall back to WEBAPP_URL without bookerUrl", async () => {
    for (const email of emails(buildEvent())) {
      expect(await html(email)).toContain(`href="${WEBAPP_URL}"`);
    }
  });
});
