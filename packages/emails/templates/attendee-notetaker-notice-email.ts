import { COMPANY_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import renderEmail from "../src/renderEmail";
import BaseEmail from "./_base-email";

// No field here may carry transcript text, summary text or a link: attendees have no access until a host shares.
export type NotetakerAttendeeNoticeEmailInput = {
  t: TFunction;
  locale: string;
  timeZone: string;
  to: { email: string; name: string | null };
  bookingTitle: string;
  bookingStartTime: Date;
  hostName: string;
  isPending: boolean;
};

export default class AttendeeNotetakerNoticeEmail extends BaseEmail {
  input: NotetakerAttendeeNoticeEmailInput;

  constructor(input: NotetakerAttendeeNoticeEmailInput) {
    super();
    this.name = "SEND_NOTETAKER_ATTENDEE_NOTICE";
    this.input = input;
  }

  private getBookingDate(): string {
    const { locale, timeZone, bookingStartTime } = this.input;
    return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(
      bookingStartTime
    );
  }

  private getBodyKey(): string {
    return this.input.isPending
      ? "notetaker_attendee_notice_email_body_pending"
      : "notetaker_attendee_notice_email_body";
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const { t, to, bookingTitle, hostName, isPending } = this.input;
    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: to.name ? `${to.name} <${to.email}>` : to.email,
      subject: t("notetaker_attendee_notice_email_subject", { title: bookingTitle }),
      html: await renderEmail("NotetakerAttendeeNoticeEmail", {
        language: t,
        recipientName: to.name,
        bookingTitle,
        bookingDate: this.getBookingDate(),
        hostName,
        isPending,
      }),
      text: this.getTextBody(),
    };
  }

  protected getTextBody(): string {
    const { t, to, bookingTitle, hostName } = this.input;
    const lines: string[] = [t("notetaker_attendee_notice_email_title")];

    if (to.name !== null) lines.push(`${t("hi_user_name", { name: to.name })},`);
    lines.push(t(this.getBodyKey(), { hostName, title: bookingTitle, date: this.getBookingDate() }));
    lines.push(t("notetaker_attendee_notice_email_how_to_object", { hostName }));
    lines.push(`${t("happy_scheduling")},`, t("the_calcom_team", { companyName: COMPANY_NAME }));

    return lines.join("\n");
  }
}
