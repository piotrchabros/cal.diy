import { COMPANY_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TFunction } from "i18next";
import renderEmail from "../src/renderEmail";
import { NOTETAKER_OUTCOME_REASON_KEYS } from "../src/templates/NotetakerFailedEmail";
import BaseEmail from "./_base-email";

// outcomeReason is the only reason-like field so that no error code, provider message, passage or summary text can reach the email.
export type NotetakerFailedEmailInput = {
  t: TFunction;
  locale: string;
  timeZone: string;
  to: { email: string; name: string | null };
  bookingTitle: string;
  bookingStartTime: Date;
  notetakerUrl: string;
  outcomeReason: NotetakerOutcomeReasonDto;
  canEnableAgain: boolean;
};

export default class OrganizerNotetakerFailedEmail extends BaseEmail {
  input: NotetakerFailedEmailInput;

  constructor(input: NotetakerFailedEmailInput) {
    super();
    this.name = "SEND_NOTETAKER_FAILED";
    this.input = input;
  }

  private getBookingDate(): string {
    const { locale, timeZone, bookingStartTime } = this.input;
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(
      bookingStartTime
    );
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const { t, to, bookingTitle, notetakerUrl, outcomeReason, canEnableAgain } = this.input;
    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: to.name ? `${to.name} <${to.email}>` : to.email,
      subject: t("notetaker_failed_email_subject", { title: bookingTitle }),
      html: await renderEmail("NotetakerFailedEmail", {
        language: t,
        recipientName: to.name,
        bookingTitle,
        bookingDate: this.getBookingDate(),
        notetakerUrl,
        outcomeReason,
        canEnableAgain,
      }),
      text: this.getTextBody(),
    };
  }

  protected getTextBody(): string {
    const { t, to, bookingTitle, notetakerUrl, outcomeReason, canEnableAgain } = this.input;
    const lines: string[] = [t("notetaker_failed_email_title")];

    if (to.name !== null) lines.push(`${t("hi_user_name", { name: to.name })},`);
    lines.push(t("notetaker_failed_email_body", { title: bookingTitle, date: this.getBookingDate() }));
    lines.push(
      t("notetaker_failed_email_reason", { reason: t(NOTETAKER_OUTCOME_REASON_KEYS[outcomeReason]) })
    );
    lines.push(
      canEnableAgain
        ? t("notetaker_failed_email_can_enable_again")
        : t("notetaker_failed_email_cannot_enable_again")
    );
    lines.push(`${t("happy_scheduling")},`, t("the_calcom_team", { companyName: COMPANY_NAME }));
    lines.push(`${t("notetaker_email_open_notetaker_page")}: ${notetakerUrl}`);

    return lines.join("\n");
  }
}
