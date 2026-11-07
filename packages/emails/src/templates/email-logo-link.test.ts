import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import renderEmail from "../renderEmail";

const ORG_URL = "https://acme.example.com";
const LOGO_IMAGE = `${WEBAPP_URL}/emails/logo.png`;

const translate = ((key: string) => key) as unknown as TFunction;

const organizer: Person = {
  name: "Host",
  email: "host@example.com",
  timeZone: "UTC",
  language: { translate, locale: "en" },
};
const attendee: Person = { ...organizer, name: "Guest", email: "guest@example.com" };

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Intro",
  title: "Intro call",
  startTime: "2026-11-10T10:00:00.000Z",
  endTime: "2026-11-10T10:30:00.000Z",
  organizer,
  attendees: [attendee],
  uid: "booking-uid",
  ...overrides,
});

const logoHrefs = (html: string) =>
  [
    ...html.matchAll(/<a href="([^"]*)" target="_blank" rel="noreferrer"><img height="19" src="([^"]*)"/g),
  ].map(([, href, src]) => ({ href, src }));

describe("email footer logo link", () => {
  it("uses the booking's organization base URL in scheduled emails", async () => {
    const calEvent = buildEvent({ bookerUrl: ORG_URL });
    for (const html of [
      await renderEmail("AttendeeScheduledEmail", { calEvent, attendee }),
      await renderEmail("OrganizerScheduledEmail", { calEvent, attendee: organizer }),
    ]) {
      expect(logoHrefs(html)).toEqual([{ href: ORG_URL, src: LOGO_IMAGE }]);
    }
  });

  it("falls back to WEBAPP_URL when the booking has no bookerUrl", async () => {
    const html = await renderEmail("AttendeeScheduledEmail", { calEvent: buildEvent(), attendee });
    expect(logoHrefs(html)).toEqual([{ href: WEBAPP_URL, src: LOGO_IMAGE }]);
  });

  it("lets an explicit logoHref win over bookerUrl", async () => {
    const html = await renderEmail("AttendeeScheduledEmail", {
      calEvent: buildEvent({ bookerUrl: ORG_URL }),
      attendee,
      logoHref: "https://other.example.com",
    });
    expect(logoHrefs(html)).toEqual([{ href: "https://other.example.com", src: LOGO_IMAGE }]);
  });

  it("omits the logo when branding is hidden", async () => {
    const html = await renderEmail("AttendeeScheduledEmail", {
      calEvent: buildEvent({ bookerUrl: ORG_URL, hideBranding: true }),
      attendee,
    });
    expect(logoHrefs(html)).toEqual([]);
  });

  it("uses bookerUrl in the refund-failed email", async () => {
    const calEvent = buildEvent({
      bookerUrl: ORG_URL,
      paymentInfo: { amount: 1000, currency: "usd" } as CalendarEvent["paymentInfo"],
    });
    const html = await renderEmail("OrganizerPaymentRefundFailedEmail", { calEvent, attendee: organizer });
    expect(logoHrefs(html)).toEqual([{ href: ORG_URL, src: LOGO_IMAGE }]);
  });

  it.each([
    ["with baseUrl", ORG_URL, ORG_URL],
    ["without baseUrl", undefined, WEBAPP_URL],
  ])("uses the passed base URL in slug replacement and disabled app emails (%s)", async (_, baseUrl, expected) => {
    const slug = await renderEmail("SlugReplacementEmail", {
      slug: "intro",
      name: "Host",
      teamName: "Team",
      t: translate,
      baseUrl,
    });
    const disabled = await renderEmail("DisabledAppEmail", {
      appName: "Zoom",
      appType: ["video"],
      t: translate,
      baseUrl,
    });
    expect(logoHrefs(slug)).toEqual([{ href: expected, src: LOGO_IMAGE }]);
    expect(logoHrefs(disabled)).toEqual([{ href: expected, src: LOGO_IMAGE }]);
  });

  it("uses the passed base URL for the header and footer logos in the V2 layout", async () => {
    const html = await renderEmail("DailyVideoDownloadRecordingEmail", {
      language: translate,
      name: "Guest",
      title: "Intro call",
      date: "Tuesday",
      downloadLink: "https://download.example/rec",
      baseUrl: ORG_URL,
    });
    const links = logoHrefs(html);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.href === ORG_URL && link.src === LOGO_IMAGE)).toBe(true);
  });

  it("keeps WEBAPP_URL for emails without an organization context", async () => {
    const html = await renderEmail("ForgotPasswordEmail", {
      language: translate,
      user: { name: "Guest", email: "guest@example.com" },
      resetLink: "https://reset.example",
    });
    expect(logoHrefs(html)).toEqual([{ href: WEBAPP_URL, src: LOGO_IMAGE }]);
  });
});
