"use client";

import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Badge } from "@calcom/ui/components/badge";

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

export function NotetakerStatusBadge({ status }: { status: NotetakerSessionStatusDto }): JSX.Element {
  const { t } = useLocale();
  const { variant, labelKey } = STATUS_BADGE[status];

  return (
    <Badge variant={variant} data-testid="notetaker-status-badge">
      {t(labelKey)}
    </Badge>
  );
}
