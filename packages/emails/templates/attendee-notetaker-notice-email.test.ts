import { WEBAPP_URL } from "@calcom/lib/constants";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import AttendeeNotetakerNoticeEmail, {
  type NotetakerAttendeeNoticeEmailInput,
} from "./attendee-notetaker-notice-email";

class TestEmail extends AttendeeNotetakerNoticeEmail {
  public getPayload() {
    return this.getNodeMailerPayload();
  }
}

// Distinctive values so assertions do not depend on the real common.json copy.
// i18next HTML-escapes interpolated values, so test values avoid ' & / <.
const RESOURCES = {
  notetaker_attendee_notice_email_subject: "SUBJECT-LINE {{title}}",
  notetaker_attendee_notice_email_title: "TITLE-LINE",
  notetaker_attendee_notice_email_body: "BODY-LINE {{hostName}} - {{title}} on {{date}}",
  notetaker_attendee_notice_email_body_pending: "PENDING-LINE {{hostName}} {{title}} on {{date}}",
  notetaker_attendee_notice_email_how_to_object: "OBJECT-LINE {{hostName}}",
  hi_user_name: "GREETING {{name}}",
  happy_scheduling: "HAPPY-SCHEDULING",
  the_calcom_team: "TEAM-SIGNATURE {{companyName}}",
};

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    ns: ["common"],
    defaultNS: "common",
    resources: { en: { common: RESOURCES } },
  });
});

const buildInput = (
  overrides: Partial<NotetakerAttendeeNoticeEmailInput> = {}
): NotetakerAttendeeNoticeEmailInput => ({
  t: i18n.getFixedT("en", "common"),
  locale: "en",
  timeZone: "Europe/Warsaw",
  to: { email: "guest@example.com", name: "Guest Name" },
  bookingTitle: "Planning call",
  bookingStartTime: new Date("2026-10-12T10:00:00.000Z"),
  hostName: "Host Person",
  isPending: false,
  ...overrides,
});

const render = async (overrides: Partial<NotetakerAttendeeNoticeEmailInput> = {}) => {
  const payload = await new TestEmail(buildInput(overrides)).getPayload();
  return {
    payload,
    html: typeof payload.html === "string" ? payload.html : "",
    text: typeof payload.text === "string" ? payload.text : "",
  };
};

describe("AttendeeNotetakerNoticeEmail", () => {
  it("addresses the recipient and puts the booking title in the subject", async () => {
    const { payload } = await render();

    expect(payload.to).toBe("Guest Name <guest@example.com>");
    expect(payload.subject).toBe("SUBJECT-LINE Planning call");
  });

  it("renders the confirmed notice in html and text", async () => {
    const { html, text } = await render();

    for (const body of [html, text]) {
      expect(body).toContain("TITLE-LINE");
      expect(body).toContain("GREETING Guest Name");
      expect(body).toContain("BODY-LINE Host Person");
      expect(body).toContain("Planning call");
      expect(body).toContain("OBJECT-LINE Host Person");
      expect(body).toContain("HAPPY-SCHEDULING");
      expect(body).toContain("TEAM-SIGNATURE");
      expect(body).not.toContain("PENDING-LINE");
    }
  });

  it("renders the pending wording only when the booking is pending", async () => {
    const { html, text } = await render({ isPending: true });

    for (const body of [html, text]) {
      expect(body).toContain("PENDING-LINE Host Person");
      expect(body).not.toContain("BODY-LINE");
    }
  });

  it("formats the booking date in the recipient time zone", async () => {
    const warsaw = await render();
    const newYork = await render({ timeZone: "America/New_York" });

    for (const body of [warsaw.html, warsaw.text]) {
      expect(body).toContain("October 12, 2026");
      expect(body).toContain("12:00");
    }
    for (const body of [newYork.html, newYork.text]) {
      expect(body).toContain("October 12, 2026");
      expect(body).toContain("6:00");
      expect(body).not.toContain("12:00");
    }
  });

  it("formats the booking date in the recipient locale", async () => {
    const { html } = await render({ locale: "de" });

    expect(html).toContain("Oktober");
  });

  it("addresses the bare email and skips the greeting when the recipient has no name", async () => {
    const { payload, html, text } = await render({ to: { email: "guest@example.com", name: null } });

    expect(payload.to).toBe("guest@example.com");
    expect(html).not.toContain("GREETING");
    expect(text).not.toContain("GREETING");
  });

  it.each([
    ["with a name", "Guest Name", 6],
    ["without a name", null, 5],
  ] as const)("keeps the text body in line with the html %s", async (_label, name, lineCount) => {
    const { html, text } = await render({ to: { email: "guest@example.com", name } });
    const lines = text.split("\n");

    expect(lines).toHaveLength(lineCount);
    for (const line of lines) {
      expect(html).toContain(line);
    }
  });

  it.each([
    false,
    true,
  ])("contains no link or button in the content when isPending is %s", async (isPending) => {
    const { html, text } = await render({ isPending });

    expect(text).not.toContain("http");

    const allowedChromeUrls = [WEBAPP_URL, `${WEBAPP_URL}/emails/logo.png`];
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    for (const url of urls) {
      const isAllowed =
        url === "http://www.w3.org/1999/xhtml" ||
        url.startsWith("https://fonts.googleapis.com/") ||
        allowedChromeUrls.includes(url);
      expect(isAllowed, `unexpected URL in html: ${url}`).toBe(true);
    }

    expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(html).not.toContain("/booking/");
    expect(html).not.toContain("/notetaker");

    const content = html.slice(html.indexOf("TITLE-LINE"), html.indexOf("TEAM-SIGNATURE"));
    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain("http");
    expect(content).not.toContain("href");
    expect(content).not.toContain("<a");
  });

  it("returns exactly the five mailer fields and names the email", async () => {
    const email = new TestEmail(buildInput());
    const payload = await email.getPayload();

    expect(Object.keys(payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(email.name).toBe("SEND_NOTETAKER_ATTENDEE_NOTICE");
  });
});
