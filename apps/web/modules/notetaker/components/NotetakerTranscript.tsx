"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Button } from "@calcom/ui/components/button";
import { Fragment } from "react";

function formatTimestamp(startMs: number): string {
  const totalSeconds = Math.floor(startMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");

  if (hours === 0) return `${minutes}:${paddedSeconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
}

function getInterruptionMarkerPosition(
  passages: { startMs: number }[],
  interruptedAtMs: number | null | undefined,
  hasNextPage: boolean
): number | null {
  if (typeof interruptedAtMs !== "number") return null;

  const firstAfter = passages.findIndex((passage) => passage.startMs >= interruptedAtMs);
  if (firstAfter !== -1) return firstAfter;
  // The marker waits for the page that contains the interruption point.
  if (hasNextPage) return null;
  return passages.length;
}

export function NotetakerTranscript({
  bookingUid,
  sessionId,
  interruptedAtMs,
}: {
  bookingUid: string;
  sessionId?: string;
  interruptedAtMs?: number | null;
}): JSX.Element {
  const { t } = useLocale();
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.viewer.notetaker.listPassages.useInfiniteQuery(
      { bookingUid, sessionId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined }
    );

  if (isPending) return <p className="text-sm text-subtle">{t("notetaker_transcript_loading")}</p>;
  if (isError) return <p className="text-sm text-subtle">{t("error_loading_data")}</p>;

  const passages = data.pages.flatMap((page) => page.passages);
  if (passages.length === 0) return <p className="text-sm text-subtle">{t("notetaker_transcript_empty")}</p>;

  const markerPosition = getInterruptionMarkerPosition(passages, interruptedAtMs, hasNextPage);
  const marker =
    markerPosition !== null && typeof interruptedAtMs === "number" ? (
      <li className="text-subtle text-xs" data-testid="notetaker-interruption-marker">
        {t("notetaker_interrupted_at", { time: formatTimestamp(interruptedAtMs) })}
      </li>
    ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="notetaker-transcript">
      <ol className="flex flex-col gap-4">
        {passages.map((passage, position) => (
          <Fragment key={passage.index}>
            {position === markerPosition && marker}
            <li className="flex flex-col gap-1" data-testid="notetaker-passage">
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-emphasis text-sm">
                  {passage.speakerName ??
                    t("notetaker_unknown_speaker", { number: passage.unknownSpeakerNumber })}
                </span>
                <span className="text-subtle text-xs tabular-nums">{formatTimestamp(passage.startMs)}</span>
              </div>
              <p className="whitespace-pre-wrap text-default text-sm">{passage.text}</p>
            </li>
          </Fragment>
        ))}
        {markerPosition === passages.length && marker}
      </ol>
      {hasNextPage && (
        <div>
          <Button color="secondary" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            {t("notetaker_load_more_passages")}
          </Button>
        </div>
      )}
    </div>
  );
}
