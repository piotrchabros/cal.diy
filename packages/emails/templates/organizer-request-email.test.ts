import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";
import { createInstance } from "i18next";
import { describe, expect, it, vi } from "vitest";
import renderEmail from "../src/renderEmail";
import OrganizerRequestEmail from "./organizer-request-email";

vi.mock("@calcom/lib/crypto", () => ({ symmetricEncrypt: () => "encrypted-token" }));

vi.mock("@calcom/features/flags/operations/check-if-user-has-feature.controller", () => ({
  checkIfUserHasFeatureController: vi.fn().mockResolvedValue(false),
}));

const ORG_URL = "https://org.example.com";

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: {
    en: {
      common: {
        broken_video_action: "VIDEO <0>event type</0> <1>apps</1>",
        broken_calendar_action: "CALENDAR {{calendarSettingsLink}}",
      },
    },
  },
  ns: ["common"],
  defaultNS: "common",
});
const translate = i18n.getFixedT("en", "common");

const organizer: Person = {
  id: 7,
  name: "Host",
  email: "host@example.com",
  timeZone: "UTC",
  language: { translate, locale: "en" },
};

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Intro",
  title: "Intro call",
  startTime: "2026-11-10T10:00:00.000Z",
  endTime: "2026-11-10T10:30:00.000Z",
  organizer,
  attendees: [{ ...organizer, name: "Guest", email: "guest@example.com" }],
  uid: "booking-uid",
  oneTimePassword: "otp",
  ...overrides,
});

class TestOrganizerRequestEmail extends OrganizerRequestEmail {
  public textBody() {
    return this.getTextBody();
  }
}

describe("organizer request email links", () => {
  it.each([
    "OrganizerRequestEmail",
    "OrganizerRequestEmailV2",
  ] as const)("%s points confirm/reject at the organizer's base URL", async (template) => {
    const html = await renderEmail(template, {
      calEvent: buildEvent({ bookerUrl: ORG_URL }),
      attendee: organizer,
    });

    expect(html).toContain(`${ORG_URL}/api/`);
    expect(html).not.toContain(`${WEBAPP_URL}/api/`);
  });

  it.each([
    "OrganizerRequestEmail",
    "OrganizerRequestEmailV2",
  ] as const)("%s falls back to WEBAPP_URL without bookerUrl", async (template) => {
    const html = await renderEmail(template, { calEvent: buildEvent(), attendee: organizer });

    expect(html).toContain(`${WEBAPP_URL}/api/`);
  });

  it("builds the plain-text bookings link from bookerUrl", () => {
    const email = new TestOrganizerRequestEmail({ calEvent: buildEvent({ bookerUrl: ORG_URL }) });

    expect(email.textBody()).toContain(`${ORG_URL}/bookings/upcoming`);
  });

  it("uses the recurring bookings path and the WEBAPP_URL fallback", () => {
    const email = new TestOrganizerRequestEmail({
      calEvent: buildEvent({ recurringEvent: { freq: 2, count: 3, interval: 1 } }),
    });

    expect(email.textBody()).toContain(`${WEBAPP_URL}/bookings/recurring`);
  });
});

describe("BrokenIntegrationEmail links", () => {
  it.each(["video", "calendar"] as const)("uses the organizer's base URL for %s", async (type) => {
    const html = await renderEmail("BrokenIntegrationEmail", {
      calEvent: buildEvent({ bookerUrl: ORG_URL, eventTypeId: 12 }),
      attendee: organizer,
      type,
    });

    expect(html).toContain(`${ORG_URL}/apps/installed`);
    if (type === "video") expect(html).toContain(`${ORG_URL}/event-types/12`);
  });

  it("falls back to WEBAPP_URL without bookerUrl", async () => {
    const html = await renderEmail("BrokenIntegrationEmail", {
      calEvent: buildEvent(),
      attendee: organizer,
      type: "video",
    });

    expect(html).toContain(`${WEBAPP_URL}/event-types`);
    expect(html).toContain(`${WEBAPP_URL}/apps/installed`);
  });
});
