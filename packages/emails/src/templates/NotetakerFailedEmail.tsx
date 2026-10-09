import { COMPANY_NAME } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TFunction } from "i18next";
import { CallToAction } from "../components/CallToAction";
import { V2BaseEmailHtml } from "../components/V2BaseEmailHtml";

interface NotetakerFailedEmailProps {
  language: TFunction;
  recipientName: string | null;
  bookingTitle: string;
  bookingDate: string;
  notetakerUrl: string;
  outcomeReason: NotetakerOutcomeReasonDto;
  canEnableAgain: boolean;
}

// Exported so the email class builds its text body from the same map instead of a second copy.
export const NOTETAKER_OUTCOME_REASON_KEYS: Record<NotetakerOutcomeReasonDto, string> = {
  NOT_ADMITTED: "notetaker_reason_not_admitted",
  MEETING_DID_NOT_START: "notetaker_reason_meeting_did_not_start",
  NO_SPEECH_DETECTED: "notetaker_reason_no_speech_detected",
  REMOVED_BY_PARTICIPANT: "notetaker_reason_removed_by_participant",
  STOPPED_BY_HOST: "notetaker_reason_stopped_by_host",
  INTERRUPTED: "notetaker_reason_interrupted",
  LENGTH_LIMIT_REACHED: "notetaker_reason_length_limit_reached",
  MEETING_LINK_UNUSABLE: "notetaker_reason_meeting_link_unusable",
};

export const NotetakerFailedEmail = (
  props: NotetakerFailedEmailProps & Partial<React.ComponentProps<typeof V2BaseEmailHtml>>
) => {
  const {
    language,
    recipientName,
    bookingTitle,
    bookingDate,
    notetakerUrl,
    outcomeReason,
    canEnableAgain,
    ...baseProps
  } = props;

  return (
    <V2BaseEmailHtml
      {...baseProps}
      subject={language("notetaker_failed_email_subject", { title: bookingTitle })}
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
        <>{language("notetaker_failed_email_title")}</>
      </p>
      {recipientName !== null && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>{language("hi_user_name", { name: recipientName })},</>
        </p>
      )}
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>{language("notetaker_failed_email_body", { title: bookingTitle, date: bookingDate })}</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>
          {language("notetaker_failed_email_reason", {
            reason: language(NOTETAKER_OUTCOME_REASON_KEYS[outcomeReason]),
          })}
        </>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>
          {canEnableAgain
            ? language("notetaker_failed_email_can_enable_again")
            : language("notetaker_failed_email_cannot_enable_again")}
        </>
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
