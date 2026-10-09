import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import OrganizerNotetakerResultsReadyEmail, {
  type NotetakerResultsReadyEmailInput,
} from "./organizer-notetaker-results-ready-email";

class TestEmail extends OrganizerNotetakerResultsReadyEmail {
  public getPayload() {
    return this.getNodeMailerPayload();
  }
}

// Distinctive values so assertions do not depend on the real common.json copy.
const RESOURCES = {
  notetaker_results_ready_email_subject: "SUBJECT-LINE {{title}}",
  notetaker_results_ready_email_title: "TITLE-LINE",
  notetaker_results_ready_email_body: "BODY-LINE {{title}} on {{date}}",
  notetaker_results_ready_email_ended_early: "ENDED-EARLY {{reason}}",
  notetaker_results_ready_email_truncated: "TRUNCATED-LINE",
  notetaker_results_ready_email_no_summary: "NO-SUMMARY-LINE",
  notetaker_reason_removed_by_participant: "REASON-REMOVED",
  notetaker_reason_stopped_by_host: "REASON-STOPPED",
  notetaker_reason_interrupted: "REASON-INTERRUPTED",
  notetaker_view_transcript: "VIEW-TRANSCRIPT-BUTTON",
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
  overrides: Partial<NotetakerResultsReadyEmailInput> = {}
): NotetakerResultsReadyEmailInput => ({
  t: i18n.getFixedT("en", "common"),
  locale: "en",
  timeZone: "Europe/Warsaw",
  to: { email: "host@example.com", name: "Host Name" },
  bookingTitle: "Planning call",
  bookingStartTime: new Date("2026-10-12T10:00:00.000Z"),
  resultsUrl: "https://app.example.com/booking/uid-1/notetaker",
  sessionStatus: "READY",
  outcomeReason: null,
  transcriptCompleteness: "COMPLETE",
  summaryStatus: "READY",
  ...overrides,
});

const render = async (overrides: Partial<NotetakerResultsReadyEmailInput> = {}) => {
  const payload = await new TestEmail(buildInput(overrides)).getPayload();
  return {
    payload,
    html: typeof payload.html === "string" ? payload.html : "",
    text: typeof payload.text === "string" ? payload.text : "",
  };
};

describe("OrganizerNotetakerResultsReadyEmail", () => {
  it("renders a complete transcript with a summary", async () => {
    const { payload, html, text } = await render();

    expect(payload.to).toBe("Host Name <host@example.com>");
    expect(payload.subject).toContain("Planning call");
    expect(html).toContain("TITLE-LINE");
    expect(html).toContain("BODY-LINE Planning call");
    expect(html).toContain('href="https://app.example.com/booking/uid-1/notetaker"');
    expect(html).toContain("VIEW-TRANSCRIPT-BUTTON");
    expect(html).toContain("GREETING Host Name");
    expect(html).not.toContain("ENDED-EARLY");
    expect(html).not.toContain("TRUNCATED-LINE");
    expect(html).not.toContain("NO-SUMMARY-LINE");
    expect(text).toContain("https://app.example.com/booking/uid-1/notetaker");
  });

  it("formats the booking date in the recipient time zone", async () => {
    const { html } = await render();

    expect(html).toContain("October 12, 2026");
    expect(html).toContain("12:00");
  });

  it.each([
    ["REMOVED_BY_PARTICIPANT", "REASON-REMOVED"],
    ["STOPPED_BY_HOST", "REASON-STOPPED"],
    ["INTERRUPTED", "REASON-INTERRUPTED"],
  ] as const)("renders the ended-early line for reason %s", async (outcomeReason, expectedReason) => {
    const { html, text } = await render({ sessionStatus: "ENDED_EARLY", outcomeReason });

    expect(html).toContain(`ENDED-EARLY ${expectedReason}`);
    expect(text).toContain(`ENDED-EARLY ${expectedReason}`);
  });

  it("falls back to the interrupted reason when an ended-early session has no reason", async () => {
    const { html } = await render({ sessionStatus: "ENDED_EARLY", outcomeReason: null });

    expect(html).toContain("ENDED-EARLY REASON-INTERRUPTED");
  });

  it("ignores the outcome reason for a session that finished normally", async () => {
    const { html, text } = await render({ sessionStatus: "READY", outcomeReason: "LENGTH_LIMIT_REACHED" });

    expect(html).not.toContain("ENDED-EARLY");
    expect(text).not.toContain("ENDED-EARLY");
  });

  it("renders the truncated line only for a truncated transcript", async () => {
    const truncated = await render({ transcriptCompleteness: "TRUNCATED" });
    const partial = await render({ transcriptCompleteness: "PARTIAL" });

    expect(truncated.html).toContain("TRUNCATED-LINE");
    expect(truncated.text).toContain("TRUNCATED-LINE");
    expect(partial.html).not.toContain("TRUNCATED-LINE");
    expect(partial.text).not.toContain("TRUNCATED-LINE");
  });

  it.each([
    null,
    "FAILED",
    "NOT_ENOUGH_CONTENT",
  ] as const)("renders the no-summary line when the summary status is %s", async (summaryStatus) => {
    const { html, text } = await render({ summaryStatus });

    expect(html).toContain("NO-SUMMARY-LINE");
    expect(text).toContain("NO-SUMMARY-LINE");
  });

  it.each([
    "PENDING",
    "READY",
  ] as const)("omits the no-summary line when the summary status is %s", async (summaryStatus) => {
    const { html, text } = await render({ summaryStatus });

    expect(html).not.toContain("NO-SUMMARY-LINE");
    expect(text).not.toContain("NO-SUMMARY-LINE");
  });

  it("addresses the bare email and skips the greeting when the recipient has no name", async () => {
    const { payload, html } = await render({ to: { email: "host@example.com", name: null } });

    expect(payload.to).toBe("host@example.com");
    expect(html).not.toContain("GREETING");
  });

  it("returns exactly the five mailer fields and names the email", async () => {
    const email = new TestEmail(buildInput());
    const payload = await email.getPayload();

    expect(Object.keys(payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(email.name).toBe("SEND_NOTETAKER_RESULTS_READY");
  });
});
