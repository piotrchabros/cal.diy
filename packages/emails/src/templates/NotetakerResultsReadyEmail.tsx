import { COMPANY_NAME } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TFunction } from "i18next";
import { CallToAction } from "../components/CallToAction";
import { V2BaseEmailHtml } from "../components/V2BaseEmailHtml";

interface NotetakerResultsReadyEmailProps {
  language: TFunction;
  recipientName: string | null;
  bookingTitle: string;
  bookingDate: string;
  resultsUrl: string;
  endedEarlyReason: NotetakerOutcomeReasonDto | null;
  isTruncated: boolean;
  isSummaryMissing: boolean;
}

const ENDED_EARLY_REASON_KEYS: Partial<Record<NotetakerOutcomeReasonDto, string>> = {
  REMOVED_BY_PARTICIPANT: "notetaker_reason_removed_by_participant",
  STOPPED_BY_HOST: "notetaker_reason_stopped_by_host",
  INTERRUPTED: "notetaker_reason_interrupted",
};

export const NotetakerResultsReadyEmail = (
  props: NotetakerResultsReadyEmailProps & Partial<React.ComponentProps<typeof V2BaseEmailHtml>>
) => {
  const {
    language,
    recipientName,
    bookingTitle,
    bookingDate,
    resultsUrl,
    endedEarlyReason,
    isTruncated,
    isSummaryMissing,
    ...baseProps
  } = props;

  return (
    <V2BaseEmailHtml
      {...baseProps}
      subject={language("notetaker_results_ready_email_subject", { title: bookingTitle })}
      callToAction={
        <CallToAction
          label={language("notetaker_view_transcript")}
          href={resultsUrl}
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
        <>{language("notetaker_results_ready_email_title")}</>
      </p>
      {recipientName !== null && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>{language("hi_user_name", { name: recipientName })},</>
        </p>
      )}
      <p style={{ fontWeight: 400, lineHeight: "24px" }}>
        <>{language("notetaker_results_ready_email_body", { title: bookingTitle, date: bookingDate })}</>
      </p>
      {endedEarlyReason !== null && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>
            {language("notetaker_results_ready_email_ended_early", {
              reason: language(ENDED_EARLY_REASON_KEYS[endedEarlyReason] ?? "notetaker_reason_interrupted"),
            })}
          </>
        </p>
      )}
      {isTruncated && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>{language("notetaker_results_ready_email_truncated")}</>
        </p>
      )}
      {isSummaryMissing && (
        <p style={{ fontWeight: 400, lineHeight: "24px" }}>
          <>{language("notetaker_results_ready_email_no_summary")}</>
        </p>
      )}
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "32px", marginBottom: "8px" }}>
        <>{language("happy_scheduling")},</>
      </p>
      <p style={{ fontWeight: 400, lineHeight: "24px", marginTop: "0px" }}>
        <>{language("the_calcom_team", { companyName: COMPANY_NAME })}</>
      </p>
    </V2BaseEmailHtml>
  );
};
