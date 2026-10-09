import { COMPANY_NAME } from "@calcom/lib/constants";
import type { TFunction } from "i18next";
import { CallToAction } from "../components/CallToAction";
import { V2BaseEmailHtml } from "../components/V2BaseEmailHtml";

interface NotetakerTurnedOffEmailProps {
  language: TFunction;
  recipientName: string | null;
  bookingTitle: string;
  bookingDate: string;
  notetakerUrl: string;
}

export const NotetakerTurnedOffEmail = (
  props: NotetakerTurnedOffEmailProps & Partial<React.ComponentProps<typeof V2BaseEmailHtml>>
) => {
  const { language, recipientName, bookingTitle, bookingDate, notetakerUrl, ...baseProps } = props;

  return (
    <V2BaseEmailHtml
      {...baseProps}
      subject={language("notetaker_turned_off_email_subject", { title: bookingTitle })}
      callToAction={
        <CallToAction
          label={language("notetaker_email_open_notetaker_page")}
          href={notetakerUrl}
          endIconName="white-arrow-right"
        />
      }>
      <p
        style={{
          fontSize: "32px",
          fontWeight: "600",
          lineHeight: "38.5px",
          marginBottom: "40px",
          color: "black",
        }}>
        <>{language("notetaker_turned_off_email_title")}</>
      </p>
      {recipientName !== null && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>{language("hi_user_name", { name: recipientName })},</>
        </p>
      )}
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>{language("notetaker_turned_off_email_body", { title: bookingTitle, date: bookingDate })}</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>{language("notetaker_turned_off_email_reason")}</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>{language("notetaker_turned_off_email_how_to_resume")}</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "32px", marginBottom: "8px" }}>
        <>{language("happy_scheduling")},</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "0px" }}>
        <>{language("the_calcom_team", { companyName: COMPANY_NAME })}</>
      </p>
    </V2BaseEmailHtml>
  );
};
