"use client";

import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { NotetakerActivityList } from "@calcom/web/modules/notetaker/components/NotetakerActivityList";
import { NotetakerResultsActions } from "@calcom/web/modules/notetaker/components/NotetakerResultsActions";
import { NotetakerStatusBadge } from "@calcom/web/modules/notetaker/components/NotetakerStatusBadge";
import { NotetakerSummary } from "@calcom/web/modules/notetaker/components/NotetakerSummary";
import { NotetakerTranscript } from "@calcom/web/modules/notetaker/components/NotetakerTranscript";
import { useNotetakerMutations } from "@calcom/web/modules/notetaker/hooks/useNotetakerMutations";
import { useNotetakerState } from "@calcom/web/modules/notetaker/hooks/useNotetakerState";
import { NOTETAKER_OUTCOME_REASON_KEYS } from "@calcom/web/modules/notetaker/lib/outcomeReasonKeys";
import type { TFunction } from "i18next";

function endedEarlyLabel(outcomeReason: NotetakerOutcomeReasonDto | null, t: TFunction): string {
  switch (outcomeReason) {
    case "REMOVED_BY_PARTICIPANT":
      return t("notetaker_ended_early_removed_by_participant");
    case "STOPPED_BY_HOST":
      return t("notetaker_ended_early_stopped_by_host");
    default:
      return t("notetaker_transcript_incomplete", {
        reason: t(NOTETAKER_OUTCOME_REASON_KEYS[outcomeReason ?? "INTERRUPTED"]),
      });
  }
}

export function NotetakerResultsPage({ bookingUid }: { bookingUid: string }): JSX.Element {
  const { t } = useLocale();
  const { data: state, isLoading, error } = useNotetakerState(bookingUid);
  const { regenerateSummary } = useNotetakerMutations();

  if (isLoading) {
    return (
      <div role="status" aria-label={t("loading")}>
        <SkeletonText className="h-4 w-48" />
      </div>
    );
  }

  // The error text is not shown: a Forbidden or NotFound message would tell a visitor without access whether the booking exists
  if (error || !state) {
    return <p className="text-sm text-subtle">{t("something_went_wrong")}</p>;
  }

  const endedEarlyText =
    state.transcript?.completeness === "PARTIAL"
      ? endedEarlyLabel(state.session?.outcomeReason ?? null, t)
      : null;

  const startedLateText = state.session?.startedLate ? (
    <p className="text-sm text-subtle" data-testid="notetaker-started-late">
      {t("notetaker_started_late")}
    </p>
  ) : null;

  const resultsDeleted = state.transcript === null && state.session?.resultsDeletedAt != null;

  return (
    <div className="flex flex-col gap-4">
      {state.status !== null && (
        <div>
          <NotetakerStatusBadge
            status={state.status}
            outcomeReason={state.session?.status === state.status ? state.session.outcomeReason : null}
          />
        </div>
      )}
      {/* No sessionId: the default of listPassages is the latest session with a transcript, the one getState describes; state.session can be a later session without one */}
      {state.transcript !== null ? (
        <>
          <NotetakerResultsActions
            bookingUid={bookingUid}
            viewerRole={state.viewerRole}
            sharedWithAttendees={state.sharedWithAttendees}
            sessionStatus={state.session?.status ?? null}
          />
          {endedEarlyText !== null && (
            <p className="text-sm text-subtle" data-testid="notetaker-ended-early-label">
              {endedEarlyText}
            </p>
          )}
          {state.transcript.completeness === "TRUNCATED" && (
            <p className="text-sm text-subtle" data-testid="notetaker-truncated-label">
              {t("notetaker_transcript_truncated")}
            </p>
          )}
          {startedLateText}
          <NotetakerSummary
            summary={state.summary}
            viewerRole={state.viewerRole}
            onRegenerate={() => regenerateSummary.mutate({ bookingUid })}
            isRegenerating={regenerateSummary.isPending}
          />
          <NotetakerTranscript
            bookingUid={bookingUid}
            speakerNamesAvailable={state.transcript.speakerNamesAvailable}
            interruptedAtMs={
              state.transcript.completeness === "PARTIAL" ? (state.session?.interruptedAtMs ?? null) : null
            }
          />
        </>
      ) : (
        <>
          {startedLateText}
          {resultsDeleted ? (
            <p className="text-sm text-subtle" data-testid="notetaker-results-deleted">
              {t("notetaker_results_deleted")}
            </p>
          ) : (
            <p className="text-sm text-subtle">{t("notetaker_transcript_empty")}</p>
          )}
        </>
      )}
      {state.viewerRole === "HOST" && <NotetakerActivityList bookingUid={bookingUid} />}
    </div>
  );
}
