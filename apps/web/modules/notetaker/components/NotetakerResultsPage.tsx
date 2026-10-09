"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import { NotetakerStatusBadge } from "@calcom/web/modules/notetaker/components/NotetakerStatusBadge";
import { NotetakerTranscript } from "@calcom/web/modules/notetaker/components/NotetakerTranscript";
import { useNotetakerState } from "@calcom/web/modules/notetaker/hooks/useNotetakerState";

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

  return (
    <div className="flex flex-col gap-4">
      {state.status !== null && (
        <div>
          <NotetakerStatusBadge status={state.status} />
        </div>
      )}
      {/* No sessionId: the default of listPassages is the latest session with a transcript, the one getState describes; state.session can be a later session without one */}
      {state.transcript !== null ? (
        <NotetakerTranscript bookingUid={bookingUid} />
      ) : (
        <p className="text-sm text-subtle">{t("notetaker_transcript_empty")}</p>
      )}
    </div>
  );
}
