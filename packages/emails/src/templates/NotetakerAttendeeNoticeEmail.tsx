import { COMPANY_NAME } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { V2BaseEmailHtml } from "../components/V2BaseEmailHtml";

interface NotetakerAttendeeNoticeEmailProps {
  language: TFunction;
  recipientName: string | null;
  bookingTitle: string;
  bookingDate: string;
  hostName: string;
  isPending: boolean;
}

export const NotetakerAttendeeNoticeEmail = (
  props: NotetakerAttendeeNoticeEmailProps & Partial<React.ComponentProps<typeof V2BaseEmailHtml>>
) => {
  const { language, recipientName, bookingTitle, bookingDate, hostName, isPending, ...baseProps } = props;

  return (
    <V2BaseEmailHtml
      {...baseProps}
      subject={language("notetaker_attendee_notice_email_subject", { title: bookingTitle })}>
      <p
        style={{
          fontSize: "32px",
          fontWeight: "600",
          lineHeight: "38.5px",
          marginBottom: "40px",
          color: "black",
        }}>
        {language("notetaker_attendee_notice_email_title")}
      </p>
      {recipientName !== null && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          {language("hi_user_name", { name: recipientName })},
        </p>
      )}
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        {language(
          isPending ? "notetaker_attendee_notice_email_body_pending" : "notetaker_attendee_notice_email_body",
          { hostName, title: bookingTitle, date: bookingDate }
        )}
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        {language("notetaker_attendee_notice_email_how_to_object", { hostName })}
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "32px", marginBottom: "8px" }}>
        {language("happy_scheduling")},
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "0px" }}>
        {language("the_calcom_team", { companyName: COMPANY_NAME })}
      </p>
    </V2BaseEmailHtml>
  );
};
