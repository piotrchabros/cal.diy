import { WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { NOTETAKER_OUTCOME_REASON_KEYS } from "../src/templates/NotetakerFailedEmail";
import OrganizerNotetakerFailedEmail, {
  type NotetakerFailedEmailInput,
} from "./organizer-notetaker-failed-email";

class TestEmail extends OrganizerNotetakerFailedEmail {
  public getPayload() {
    return this.getNodeMailerPayload();
  }
}

// Distinctive values so assertions do not depend on the real common.json copy. The reason texts are
// opaque (no enum names inside) so the check that a raw enum value never leaks into the email means
// something. Values avoid ' & / < because i18next HTML-escapes interpolated values.
const RESOURCES = {
  notetaker_failed_email_subject: "SUBJECT-LINE {{title}}",
  notetaker_failed_email_title: "TITLE-LINE",
  notetaker_failed_email_body: "BODY-LINE {{title}} on {{date}}",
  notetaker_failed_email_reason: "WHY-LINE {{reason}}",
  notetaker_failed_email_can_enable_again: "RETRY-ALLOWED-LINE",
  notetaker_failed_email_cannot_enable_again: "RETRY-BLOCKED-LINE",
  notetaker_email_open_notetaker_page: "OPEN-PAGE-BUTTON",
  notetaker_reason_not_admitted: "CAUSE-ALPHA",
  notetaker_reason_meeting_did_not_start: "CAUSE-BRAVO",
  notetaker_reason_no_speech_detected: "CAUSE-CHARLIE",
  notetaker_reason_removed_by_participant: "CAUSE-DELTA",
  notetaker_reason_stopped_by_host: "CAUSE-ECHO",
  notetaker_reason_interrupted: "CAUSE-FOXTROT",
  notetaker_reason_length_limit_reached: "CAUSE-GOLF",
  notetaker_reason_meeting_link_unusable: "CAUSE-HOTEL",
  hi_user_name: "GREETING {{name}}",
  happy_scheduling: "HAPPY-SCHEDULING",
  the_calcom_team: "TEAM-SIGNATURE {{companyName}}",
};

const REASON_CASES: ReadonlyArray<readonly [NotetakerOutcomeReasonDto, string]> = [
  ["NOT_ADMITTED", "CAUSE-ALPHA"],
  ["MEETING_DID_NOT_START", "CAUSE-BRAVO"],
  ["NO_SPEECH_DETECTED", "CAUSE-CHARLIE"],
  ["REMOVED_BY_PARTICIPANT", "CAUSE-DELTA"],
  ["STOPPED_BY_HOST", "CAUSE-ECHO"],
  ["INTERRUPTED", "CAUSE-FOXTROT"],
  ["LENGTH_LIMIT_REACHED", "CAUSE-GOLF"],
  ["MEETING_LINK_UNUSABLE", "CAUSE-HOTEL"],
];
const RAW_REASONS = REASON_CASES.map(([reason]) => reason);

const NOTETAKER_URL = "https://app.example.com/booking/uid-1/notetaker";

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

const buildInput = (overrides: Partial<NotetakerFailedEmailInput> = {}): NotetakerFailedEmailInput => ({
  t: i18n.getFixedT("en", "common"),
  locale: "en",
  timeZone: "Europe/Warsaw",
  to: { email: "host@example.com", name: "Host Name" },
  bookingTitle: "Planning call",
  bookingStartTime: new Date("2026-10-12T10:00:00.000Z"),
  notetakerUrl: NOTETAKER_URL,
  outcomeReason: "NOT_ADMITTED",
  canEnableAgain: true,
  ...overrides,
});

const render = async (overrides: Partial<NotetakerFailedEmailInput> = {}) => {
  const payload = await new TestEmail(buildInput(overrides)).getPayload();
  return {
    payload,
    html: typeof payload.html === "string" ? payload.html : "",
    text: typeof payload.text === "string" ? payload.text : "",
  };
};

describe("OrganizerNotetakerFailedEmail", () => {
  it("keeps the fixture copy free of raw reason values", () => {
    for (const value of Object.values(RESOURCES)) {
      for (const reason of RAW_REASONS) {
        expect(value).not.toContain(reason);
      }
    }
  });

  it("maps every outcome reason to its own translation key", () => {
    expect(Object.keys(NOTETAKER_OUTCOME_REASON_KEYS).sort()).toEqual([...RAW_REASONS].sort());
    expect(Object.keys(NOTETAKER_OUTCOME_REASON_KEYS)).toHaveLength(8);

    for (const reason of RAW_REASONS) {
      const key = NOTETAKER_OUTCOME_REASON_KEYS[reason];
      expect(key).toBe(`notetaker_reason_${reason.toLowerCase()}`);
      expect(Object.hasOwn(RESOURCES, key)).toBe(true);
    }
  });

  it("addresses the organizer and builds the subject", async () => {
    const { payload } = await render();

    expect(payload.to).toBe("Host Name <host@example.com>");
    expect(payload.subject).toBe("SUBJECT-LINE Planning call");
  });

  it("renders the title, greeting, body, button, link and signature in both bodies", async () => {
    const { html, text } = await render();

    for (const body of [html, text]) {
      expect(body).toContain("TITLE-LINE");
      expect(body).toContain("GREETING Host Name");
      expect(body).toContain("BODY-LINE Planning call on ");
      expect(body).toContain("October 12, 2026");
      expect(body).toContain("12:00");
      expect(body).toContain("OPEN-PAGE-BUTTON");
      expect(body).toContain(NOTETAKER_URL);
      expect(body).toContain("HAPPY-SCHEDULING");
      expect(body).toContain("TEAM-SIGNATURE");
    }
    expect(html).toContain(`href="${NOTETAKER_URL}"`);
  });

  it.each(
    REASON_CASES
  )("renders the localized reason for %s and never the raw value", async (outcomeReason, expectedText) => {
    const { html, text } = await render({ outcomeReason });
    const otherTexts = REASON_CASES.map(([, causeText]) => causeText).filter(
      (causeText) => causeText !== expectedText
    );

    for (const body of [html, text]) {
      expect(body).toContain(`WHY-LINE ${expectedText}`);
      for (const otherText of otherTexts) {
        expect(body).not.toContain(otherText);
      }
      for (const rawReason of RAW_REASONS) {
        expect(body).not.toContain(rawReason);
      }
      expect(body).not.toContain("notetaker_");
    }
  });

  it("renders the re-enable sentence that matches canEnableAgain", async () => {
    const allowed = await render({ canEnableAgain: true });
    const blocked = await render({ canEnableAgain: false });

    for (const body of [allowed.html, allowed.text]) {
      expect(body).toContain("RETRY-ALLOWED-LINE");
      expect(body).not.toContain("RETRY-BLOCKED-LINE");
    }
    for (const body of [blocked.html, blocked.text]) {
      expect(body).toContain("RETRY-BLOCKED-LINE");
      expect(body).not.toContain("RETRY-ALLOWED-LINE");
    }
  });

  it("formats the booking time in the recipient time zone", async () => {
    const { html, text } = await render({ timeZone: "America/New_York" });

    for (const body of [html, text]) {
      expect(body).toContain("6:00");
      expect(body).not.toContain("12:00");
    }
  });

  it("addresses the bare email and skips the greeting when the recipient has no name", async () => {
    const { payload, html, text } = await render({ to: { email: "host@example.com", name: null } });

    expect(payload.to).toBe("host@example.com");
    expect(html).not.toContain("GREETING");
    expect(text).not.toContain("GREETING");
  });

  it.each([
    ["with a name", "Host Name", 8],
    ["without a name", null, 7],
  ] as const)("keeps the text body in step with the html %s", async (_label, name, lineCount) => {
    const { html, text } = await render({ to: { email: "host@example.com", name } });
    const lines = text.split("\n");

    expect(lines).toHaveLength(lineCount);
    for (const line of lines.slice(0, -1)) {
      expect(html).toContain(line);
    }
    expect(lines[lines.length - 1]).toBe(`OPEN-PAGE-BUTTON: ${NOTETAKER_URL}`);
  });

  it.each([
    true,
    false,
  ])("links only to the notetaker page when canEnableAgain is %s", async (canEnableAgain) => {
    const { html, text } = await render({ canEnableAgain });
    const urlPattern = /https?:\/\/[^\s"'<>)]+/g;

    expect(text.match(urlPattern)).toEqual([NOTETAKER_URL]);

    const allowedUrls = [
      "http://www.w3.org/1999/xhtml",
      WEBAPP_URL,
      `${WEBAPP_URL}/emails/logo.png`,
      `${WEBAPP_URL}/emails/white-arrow-right.png`,
      `${WEBAPP_URL}/emails/white-arrow-right.svg`,
      NOTETAKER_URL,
    ];
    for (const url of html.match(urlPattern) ?? []) {
      const isAllowed = url.startsWith("https://fonts.googleapis.com/") || allowedUrls.includes(url);
      expect(isAllowed, `unexpected URL in html: ${url}`).toBe(true);
    }

    expect(html.match(/<a\s/g)).toHaveLength(2);
    expect(html.split(NOTETAKER_URL)).toHaveLength(2);

    const copy = html.slice(html.indexOf("TITLE-LINE"), html.indexOf("TEAM-SIGNATURE"));
    expect(copy.length).toBeGreaterThan(0);
    for (const forbidden of ["http", "href", "<a"]) {
      expect(copy).not.toContain(forbidden);
    }
  });

  it("returns exactly the five mailer fields and names the email", async () => {
    const email = new TestEmail(buildInput());
    const payload = await email.getPayload();

    expect(Object.keys(payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(email.name).toBe("SEND_NOTETAKER_FAILED");
  });
});
