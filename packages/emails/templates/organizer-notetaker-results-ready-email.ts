import { COMPANY_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import type { TFunction } from "i18next";
import renderEmail from "../src/renderEmail";
import BaseEmail from "./_base-email";

// Duplicated in NotetakerResultsReadyEmail.tsx so the text body matches the HTML line for line.
const REASON_KEYS: Partial<Record<NotetakerOutcomeReasonDto, string>> = {
  REMOVED_BY_PARTICIPANT: "notetaker_reason_removed_by_participant",
  STOPPED_BY_HOST: "notetaker_reason_stopped_by_host",
  INTERRUPTED: "notetaker_reason_interrupted",
};

// No field here may carry passage or summary text: the email only links to the results page.
export type NotetakerResultsReadyEmailInput = {
  t: TFunction;
  locale: string;
  timeZone: string;
  to: { email: string; name: string | null };
  bookingTitle: string;
  bookingStartTime: Date;
  resultsUrl: string;
  sessionStatus: Extract<NotetakerSessionStatusDto, "READY" | "ENDED_EARLY">;
  outcomeReason: NotetakerOutcomeReasonDto | null;
  transcriptCompleteness: NotetakerTranscriptCompletenessDto;
  summaryStatus: NotetakerSummaryStatusDto | null;
};

export default class OrganizerNotetakerResultsReadyEmail extends BaseEmail {
  input: NotetakerResultsReadyEmailInput;

  constructor(input: NotetakerResultsReadyEmailInput) {
    super();
    this.name = "SEND_NOTETAKER_RESULTS_READY";
    this.input = input;
  }

  private getBookingDate(): string {
    const { locale, timeZone, bookingStartTime } = this.input;
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(
      bookingStartTime
    );
  }

  private getEndedEarlyReason(): NotetakerOutcomeReasonDto | null {
    if (this.input.sessionStatus !== "ENDED_EARLY") return null;
    return this.input.outcomeReason ?? "INTERRUPTED";
  }

  private isSummaryMissing(): boolean {
    const { summaryStatus } = this.input;
    return summaryStatus === null || summaryStatus === "FAILED" || summaryStatus === "NOT_ENOUGH_CONTENT";
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const { t, to, bookingTitle, resultsUrl, transcriptCompleteness } = this.input;
    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: to.name ? `${to.name} <${to.email}>` : to.email,
      subject: t("notetaker_results_ready_email_subject", { title: bookingTitle }),
      html: await renderEmail("NotetakerResultsReadyEmail", {
        language: t,
        recipientName: to.name,
        bookingTitle,
        bookingDate: this.getBookingDate(),
        resultsUrl,
        endedEarlyReason: this.getEndedEarlyReason(),
        isTruncated: transcriptCompleteness === "TRUNCATED",
        isSummaryMissing: this.isSummaryMissing(),
      }),
      text: this.getTextBody(),
    };
  }

  protected getTextBody(): string {
    const { t, to, bookingTitle, resultsUrl, transcriptCompleteness } = this.input;
    const endedEarlyReason = this.getEndedEarlyReason();
    const lines: string[] = [t("notetaker_results_ready_email_title")];

    if (to.name !== null) lines.push(`${t("hi_user_name", { name: to.name })},`);
    lines.push(t("notetaker_results_ready_email_body", { title: bookingTitle, date: this.getBookingDate() }));
    if (endedEarlyReason !== null) {
      const reasonKey = REASON_KEYS[endedEarlyReason] ?? "notetaker_reason_interrupted";
      lines.push(t("notetaker_results_ready_email_ended_early", { reason: t(reasonKey) }));
    }
    if (transcriptCompleteness === "TRUNCATED") lines.push(t("notetaker_results_ready_email_truncated"));
    if (this.isSummaryMissing()) lines.push(t("notetaker_results_ready_email_no_summary"));
    lines.push(`${t("happy_scheduling")},`, t("the_calcom_team", { companyName: COMPANY_NAME }));
    lines.push(`${t("notetaker_view_transcript")}: ${resultsUrl}`);

    return lines.join("\n");
  }
}
