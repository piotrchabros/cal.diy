import { WEBAPP_URL } from "@calcom/lib/constants";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import OrganizerNotetakerAdmitPromptEmail, {
  type NotetakerAdmitPromptEmailInput,
} from "./organizer-notetaker-admit-prompt-email";

class TestEmail extends OrganizerNotetakerAdmitPromptEmail {
  public getPayload() {
    return this.getNodeMailerPayload();
  }
}

// Distinctive values so assertions do not depend on the real common.json copy. i18next
// HTML-escapes interpolated values, so the test values avoid ' & / <.
const RESOURCES = {
  notetaker_admit_prompt_email_subject: "SUBJECT-LINE {{title}}",
  notetaker_admit_prompt_email_title: "TITLE-LINE",
  notetaker_admit_prompt_email_body: "BODY-LINE {{title}} on {{date}}",
  notetaker_admit_prompt_email_instruction: "INSTRUCTION-LINE",
  notetaker_email_open_notetaker_page: "OPEN-PAGE-BUTTON",
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

const NOTETAKER_URL = "https://app.example.com/booking/uid-1/notetaker";

const buildInput = (
  overrides: Partial<NotetakerAdmitPromptEmailInput> = {}
): NotetakerAdmitPromptEmailInput => ({
  t: i18n.getFixedT("en", "common"),
  locale: "en",
  timeZone: "Europe/Warsaw",
  to: { email: "host@example.com", name: "Host Name" },
  bookingTitle: "Planning call",
  bookingStartTime: new Date("2026-10-12T10:00:00.000Z"),
  notetakerUrl: NOTETAKER_URL,
  ...overrides,
});

const render = async (overrides: Partial<NotetakerAdmitPromptEmailInput> = {}) => {
  const payload = await new TestEmail(buildInput(overrides)).getPayload();
  return {
    payload,
    html: typeof payload.html === "string" ? payload.html : "",
    text: typeof payload.text === "string" ? payload.text : "",
  };
};

const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/g;

describe("OrganizerNotetakerAdmitPromptEmail", () => {
  it("addresses the recipient and builds the subject from the booking title", async () => {
    const { payload } = await render();

    expect(payload.to).toBe("Host Name <host@example.com>");
    expect(payload.subject).toBe("SUBJECT-LINE Planning call");
  });

  it("renders every content line and the notetaker link in html and text", async () => {
    const { html, text } = await render();

    for (const body of [html, text]) {
      expect(body).toContain("TITLE-LINE");
      expect(body).toContain("GREETING Host Name");
      expect(body).toContain("BODY-LINE Planning call on ");
      expect(body).toContain("INSTRUCTION-LINE");
      expect(body).toContain("HAPPY-SCHEDULING");
      expect(body).toContain("TEAM-SIGNATURE");
      expect(body).toContain("OPEN-PAGE-BUTTON");
      expect(body).toContain(NOTETAKER_URL);
    }
    expect(html).toContain(`href="${NOTETAKER_URL}"`);
  });

  it("formats the booking date in the given time zone", async () => {
    const warsaw = await render({ timeZone: "Europe/Warsaw" });
    const newYork = await render({ timeZone: "America/New_York" });

    for (const body of [warsaw.html, warsaw.text]) {
      expect(body).toContain("October 12, 2026");
      expect(body).toContain("12:00");
    }
    for (const body of [newYork.html, newYork.text]) {
      expect(body).toContain("6:00");
      expect(body).not.toContain("12:00");
    }
  });

  it("formats the booking date in the given locale", async () => {
    const { html } = await render({ locale: "de" });

    expect(html).toContain("Oktober");
  });

  it("addresses the bare email and skips the greeting when the recipient has no name", async () => {
    const { payload, html, text } = await render({ to: { email: "host@example.com", name: null } });

    expect(payload.to).toBe("host@example.com");
    expect(html).not.toContain("GREETING");
    expect(text).not.toContain("GREETING");
  });

  it.each([
    ["with a name", "Host Name", 7],
    ["without a name", null, 6],
  ] as const)("mirrors the html content in the text body %s", async (_label, name, lineCount) => {
    const { html, text } = await render({ to: { email: "host@example.com", name } });
    const lines = text.split("\n");

    expect(lines).toHaveLength(lineCount);
    for (const line of lines.slice(0, -1)) {
      expect(html).toContain(line);
    }
    expect(lines[lines.length - 1]).toBe(`OPEN-PAGE-BUTTON: ${NOTETAKER_URL}`);
  });

  it("links only to the notetaker page", async () => {
    const { html, text } = await render();

    expect(text.match(URL_PATTERN)).toEqual([NOTETAKER_URL]);

    const allowedUrls = new Set([
      "http://www.w3.org/1999/xhtml",
      WEBAPP_URL,
      `${WEBAPP_URL}/emails/logo.png`,
      `${WEBAPP_URL}/emails/white-arrow-right.png`,
      `${WEBAPP_URL}/emails/white-arrow-right.svg`,
      NOTETAKER_URL,
    ]);
    for (const url of html.match(URL_PATTERN) ?? []) {
      const isAllowed = allowedUrls.has(url) || url.startsWith("https://fonts.googleapis.com/");
      expect(isAllowed, `unexpected URL in html: ${url}`).toBe(true);
    }

    // The two anchors are the button and the logo.
    expect(html.match(/<a\s/g)).toHaveLength(2);
    expect(html.split(NOTETAKER_URL)).toHaveLength(2);

    const copy = html.slice(html.indexOf("TITLE-LINE"), html.indexOf("TEAM-SIGNATURE"));
    expect(copy).not.toBe("");
    expect(copy).not.toContain("http");
    expect(copy).not.toContain("href");
    expect(copy).not.toContain("<a");
  });

  it("does not leak an untranslated key", async () => {
    const { html, text } = await render();

    // i18next echoes the key when a translation is missing.
    expect(html).not.toContain("notetaker_");
    expect(text).not.toContain("notetaker_");
  });

  it("returns exactly the five mailer fields and names the email", async () => {
    const email = new TestEmail(buildInput());
    const payload = await email.getPayload();

    expect(Object.keys(payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(email.name).toBe("SEND_NOTETAKER_ADMIT_PROMPT");
  });
});
