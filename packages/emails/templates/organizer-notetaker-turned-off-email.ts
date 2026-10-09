import { COMPANY_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import renderEmail from "../src/renderEmail";
import BaseEmail from "./_base-email";

// No field here may carry passage, summary, location or error text: the email only links to the notetaker page.
export type NotetakerTurnedOffEmailInput = {
  t: TFunction;
  locale: string;
  timeZone: string;
  to: { email: string; name: string | null };
  bookingTitle: string;
  bookingStartTime: Date;
  notetakerUrl: string;
};

export default class OrganizerNotetakerTurnedOffEmail extends BaseEmail {
  input: NotetakerTurnedOffEmailInput;

  constructor(input: NotetakerTurnedOffEmailInput) {
    super();
    this.name = "SEND_NOTETAKER_TURNED_OFF";
    this.input = input;
  }

  private getBookingDate(): string {
    const { locale, timeZone, bookingStartTime } = this.input;
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(
      bookingStartTime
    );
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const { t, to, bookingTitle, notetakerUrl } = this.input;
    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: to.name ? `${to.name} <${to.email}>` : to.email,
      subject: t("notetaker_turned_off_email_subject", { title: bookingTitle }),
      html: await renderEmail("NotetakerTurnedOffEmail", {
        language: t,
        recipientName: to.name,
        bookingTitle,
        bookingDate: this.getBookingDate(),
        notetakerUrl,
      }),
      text: this.getTextBody(),
    };
  }

  protected getTextBody(): string {
    const { t, to, bookingTitle, notetakerUrl } = this.input;
    const lines: string[] = [t("notetaker_turned_off_email_title")];

    if (to.name !== null) lines.push(`${t("hi_user_name", { name: to.name })},`);
    lines.push(t("notetaker_turned_off_email_body", { title: bookingTitle, date: this.getBookingDate() }));
    lines.push(t("notetaker_turned_off_email_reason"));
    lines.push(t("notetaker_turned_off_email_how_to_resume"));
    lines.push(`${t("happy_scheduling")},`, t("the_calcom_team", { companyName: COMPANY_NAME }));
    lines.push(`${t("notetaker_email_open_notetaker_page")}: ${notetakerUrl}`);

    return lines.join("\n");
  }
}
