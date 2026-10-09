"use client";

import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Badge } from "@calcom/ui/components/badge";
import { NOTETAKER_OUTCOME_REASON_KEYS } from "../lib/outcomeReasonKeys";

const STATUS_BADGE: Record<
  NotetakerSessionStatusDto,
  { variant: "gray" | "orange" | "blue" | "green" | "red"; labelKey: string }
> = {
  SCHEDULED: { variant: "gray", labelKey: "notetaker_status_scheduled" },
  WAITING_TO_BE_ADMITTED: { variant: "orange", labelKey: "notetaker_status_waiting_to_be_admitted" },
  TRANSCRIBING: { variant: "blue", labelKey: "notetaker_status_transcribing" },
  PROCESSING: { variant: "blue", labelKey: "notetaker_status_processing" },
  READY: { variant: "green", labelKey: "notetaker_status_ready" },
  ENDED_EARLY: { variant: "orange", labelKey: "notetaker_status_ended_early" },
  FAILED: { variant: "red", labelKey: "notetaker_status_failed" },
};

function getReasonKey(
  status: NotetakerSessionStatusDto,
  outcomeReason: NotetakerOutcomeReasonDto | null
): string | null {
  if (outcomeReason === null) return null;
  if (status === "FAILED" || status === "ENDED_EARLY") return NOTETAKER_OUTCOME_REASON_KEYS[outcomeReason];
  // A READY transcript is complete unless the length limit cut it off, so that is the only reason worth showing next to READY.
  if (status === "READY" && outcomeReason === "LENGTH_LIMIT_REACHED")
    return "notetaker_reason_length_limit_reached";
  return null;
}

export function NotetakerStatusBadge({
  status,
  outcomeReason = null,
}: {
  status: NotetakerSessionStatusDto;
  outcomeReason?: NotetakerOutcomeReasonDto | null;
}): JSX.Element {
  const { t } = useLocale();
  const { variant, labelKey } = STATUS_BADGE[status];
  const reasonKey = getReasonKey(status, outcomeReason);

  return (
    <span className="flex items-center gap-2">
      <Badge variant={variant} data-testid="notetaker-status-badge">
        {t(labelKey)}
      </Badge>
      {reasonKey !== null && (
        <span className="text-subtle text-xs" data-testid="notetaker-status-reason">
          {t(reasonKey)}
        </span>
      )}
    </span>
  );
}
