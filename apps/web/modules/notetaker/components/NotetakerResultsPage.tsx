"use client";

import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { NotetakerStatusBadge } from "@calcom/web/modules/notetaker/components/NotetakerStatusBadge";
import { NotetakerTranscript } from "@calcom/web/modules/notetaker/components/NotetakerTranscript";
import { useNotetakerState } from "@calcom/web/modules/notetaker/hooks/useNotetakerState";
import type { TFunction } from "i18next";

// Only the two on-request reasons are labelled here; the remaining reasons are a later task (T136)
function endedEarlyLabel(outcomeReason: NotetakerOutcomeReasonDto | null, t: TFunction): string | null {
  switch (outcomeReason) {
    case "REMOVED_BY_PARTICIPANT":
      return t("notetaker_ended_early_removed_by_participant");
    case "STOPPED_BY_HOST":
      return t("notetaker_ended_early_stopped_by_host");
    default:
      return null;
  }
}

export function NotetakerResultsPage({ bookingUid }: { bookingUid: string }): JSX.Element {
  const { t } = useLocale();
  const { data: state, isLoading, error } = useNotetakerState(bookingUid);

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
    state.transcript !== null && state.session?.status === "ENDED_EARLY"
      ? endedEarlyLabel(state.session.outcomeReason, t)
      : null;

  return (
    <div className="flex flex-col gap-4">
      {state.status !== null && (
        <div>
          <NotetakerStatusBadge status={state.status} />
        </div>
      )}
      {/* No sessionId: the default of listPassages is the latest session with a transcript, the one getState describes; state.session can be a later session without one */}
      {state.transcript !== null ? (
        <>
          {endedEarlyText !== null && (
            <p className="text-sm text-subtle" data-testid="notetaker-ended-early-label">
              {endedEarlyText}
            </p>
          )}
          <NotetakerTranscript bookingUid={bookingUid} />
        </>
      ) : (
        <p className="text-sm text-subtle">{t("notetaker_transcript_empty")}</p>
      )}
    </div>
  );
}
