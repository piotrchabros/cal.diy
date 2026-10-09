import { COMPANY_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import renderEmail from "../src/renderEmail";
import BaseEmail from "./_base-email";

// The email is a pointer to the shared results, so no field may hold passage text, summary text, a
// preview, a count, a language or a speaker name, and none may be added.
export type NotetakerSharedEmailInput = {
  t: TFunction;
  locale: string;
  timeZone: string;
  to: { email: string; name: string | null };
  bookingTitle: string;
  bookingStartTime: Date;
  sharedByName: string;
  notetakerUrl: string;
};

export default class AttendeeNotetakerSharedEmail extends BaseEmail {
  input: NotetakerSharedEmailInput;

  constructor(input: NotetakerSharedEmailInput) {
    super();
    this.name = "SEND_NOTETAKER_SHARED";
    this.input = input;
  }

  private getBookingDate(): string {
    const { locale, timeZone, bookingStartTime } = this.input;
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(
      bookingStartTime
    );
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const { t, to, bookingTitle, sharedByName, notetakerUrl } = this.input;
    const bookingDate = this.getBookingDate();
    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: to.name ? `${to.name} <${to.email}>` : to.email,
      subject: t("notetaker_shared_email_subject", { title: bookingTitle }),
      html: await renderEmail("NotetakerSharedEmail", {
        language: t,
        recipientName: to.name,
        bookingTitle,
        bookingDate,
        sharedByName,
        notetakerUrl,
      }),
      text: this.getTextBody(),
    };
  }

  protected getTextBody(): string {
    const { t, to, bookingTitle, sharedByName, notetakerUrl } = this.input;
    const lines: string[] = [t("notetaker_shared_email_title")];

    if (to.name !== null) lines.push(`${t("hi_user_name", { name: to.name })},`);
    lines.push(
      t("notetaker_shared_email_body", {
        sharedBy: sharedByName,
        title: bookingTitle,
        date: this.getBookingDate(),
      })
    );
    lines.push(t("notetaker_shared_email_sign_in_hint"));
    lines.push(`${t("happy_scheduling")},`, t("the_calcom_team", { companyName: COMPANY_NAME }));
    lines.push(`${t("notetaker_email_open_notetaker_page")}: ${notetakerUrl}`);

    return lines.join("\n");
  }
}
