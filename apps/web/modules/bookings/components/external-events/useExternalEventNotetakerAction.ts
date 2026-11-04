import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerAddToMeetingInitialValues } from "@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog";
import { useNotetakerAdHoc } from "@calcom/web/modules/notetaker/hooks/useNotetakerAdHoc";
import { pickAdHocDurationMinutes } from "@calcom/web/modules/notetaker/lib/adHocDuration";
import { useNotetakerFeatureEnabled } from "@calcom/web/modules/notetaker/lib/NotetakerFeatureContext";

type AdHocOptions = {
  featureEnabled: boolean;
  enabledPlatforms: readonly NotetakerPlatformDto[];
  maxDurationMinutes: number;
};

// The ad-hoc flow dispatches the bot immediately, so it is only offered once the meeting is about to start.
export const NOTETAKER_LEAD_TIME_MS = 10 * 60 * 1000;

export type ExternalEventNotetakerAction =
  | { state: "hidden" }
  | { state: "later" }
  | { state: "available"; initialValues: NotetakerAddToMeetingInitialValues };

export function getExternalEventNotetakerAction(
  event: ExternalCalendarEventDto,
  now: Date,
  options: AdHocOptions | undefined
): ExternalEventNotetakerAction {
  if (!options?.featureEnabled || event.isAllDay || !event.meetingUrl || !event.meetingPlatform) {
    return { state: "hidden" };
  }
  if (!options.enabledPlatforms.includes(event.meetingPlatform)) return { state: "hidden" };

  const nowMs = now.getTime();
  const endMs = new Date(event.end).getTime();
  if (nowMs >= endMs) return { state: "hidden" };
  if (nowMs < new Date(event.start).getTime() - NOTETAKER_LEAD_TIME_MS) return { state: "later" };

  const remainingMinutes = Math.ceil((endMs - nowMs) / 60000);
  return {
    state: "available",
    initialValues: {
      meetingUrl: event.meetingUrl,
      title: event.title ?? undefined,
      durationMinutes: pickAdHocDurationMinutes(remainingMinutes, options.maxDurationMinutes),
    },
  };
}

export function useExternalEventNotetakerAction(
  event: ExternalCalendarEventDto,
  now: Date
): ExternalEventNotetakerAction {
  const notetakerEnabled = useNotetakerFeatureEnabled();
  const { options } = useNotetakerAdHoc({ enabled: notetakerEnabled });
  if (!notetakerEnabled) return { state: "hidden" };
  return getExternalEventNotetakerAction(event, now, options.data);
}
