import { WEBAPP_URL } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type BaseEmail from "./_base-email";
import AttendeeNotetakerNoticeEmail from "./attendee-notetaker-notice-email";
import AttendeeNotetakerSharedEmail from "./attendee-notetaker-shared-email";
import OrganizerNotetakerAdmitPromptEmail from "./organizer-notetaker-admit-prompt-email";
import OrganizerNotetakerFailedEmail from "./organizer-notetaker-failed-email";
import OrganizerNotetakerResultsReadyEmail from "./organizer-notetaker-results-ready-email";
import OrganizerNotetakerTurnedOffEmail from "./organizer-notetaker-turned-off-email";

const ORG_URL = "https://acme.example.com";
const LOGO_IMAGE = `${WEBAPP_URL}/emails/logo.png`;

const translate = ((key: string) => key) as unknown as TFunction;

const common = {
  t: translate,
  locale: "en",
  timeZone: "UTC",
  to: { email: "host@example.com", name: "Host" },
  bookingTitle: "Intro call",
  bookingStartTime: new Date("2026-11-10T10:00:00.000Z"),
};
const notetakerUrl = `${ORG_URL}/booking/uid-1/notetaker`;

type LogoHref = string | null | undefined;

const builders: [string, (logoHref: LogoHref) => BaseEmail][] = [
  [
    "OrganizerNotetakerResultsReadyEmail",
    (logoHref) =>
      new OrganizerNotetakerResultsReadyEmail({
        ...common,
        resultsUrl: notetakerUrl,
        sessionStatus: "READY",
        outcomeReason: null,
        transcriptCompleteness: "COMPLETE",
        summaryStatus: "READY",
        logoHref,
      }),
  ],
  [
    "OrganizerNotetakerTurnedOffEmail",
    (logoHref) => new OrganizerNotetakerTurnedOffEmail({ ...common, notetakerUrl, logoHref }),
  ],
  [
    "OrganizerNotetakerAdmitPromptEmail",
    (logoHref) => new OrganizerNotetakerAdmitPromptEmail({ ...common, notetakerUrl, logoHref }),
  ],
  [
    "OrganizerNotetakerFailedEmail",
    (logoHref) =>
      new OrganizerNotetakerFailedEmail({
        ...common,
        notetakerUrl,
        outcomeReason: "INTERRUPTED",
        canEnableAgain: true,
        logoHref,
      }),
  ],
  [
    "AttendeeNotetakerSharedEmail",
    (logoHref) =>
      new AttendeeNotetakerSharedEmail({ ...common, sharedByName: "Host", notetakerUrl, logoHref }),
  ],
  [
    "AttendeeNotetakerNoticeEmail",
    (logoHref) =>
      new AttendeeNotetakerNoticeEmail({ ...common, hostName: "Host", isPending: false, logoHref }),
  ],
];

// getNodeMailerPayload is protected; calling it through a cast avoids subclassing every template.
const renderHtml = async (email: BaseEmail): Promise<string> => {
  const payload = await (
    email as unknown as { getNodeMailerPayload: () => Promise<{ html: string }> }
  ).getNodeMailerPayload();
  return payload.html;
};

const logoHrefs = (html: string) =>
  Array.from(
    html.matchAll(/<a href="([^"]*)" target="_blank" rel="noreferrer"><img height="19" src="([^"]*)"/g),
    ([, href, src]) => ({ href, src })
  );

describe("notetaker email footer logo link", () => {
  it.each(builders)("%s links the logo to the passed logoHref", async (_, build) => {
    const links = logoHrefs(await renderHtml(build(ORG_URL)));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.href === ORG_URL && link.src === LOGO_IMAGE)).toBe(true);
  });

  it.each(builders)("%s falls back to WEBAPP_URL without logoHref", async (_, build) => {
    for (const logoHref of [undefined, null]) {
      const links = logoHrefs(await renderHtml(build(logoHref)));
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link) => link.href === WEBAPP_URL && link.src === LOGO_IMAGE)).toBe(true);
    }
  });
});
