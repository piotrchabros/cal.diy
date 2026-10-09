"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { SettingsToggle } from "@calcom/ui/components/form";
import { showToast } from "@calcom/ui/components/toast";

function getEventTypeReasonKey(reason: string | null): string | null {
  switch (reason) {
    case "FEATURE_DISABLED":
      return "notetaker_unavailable_feature_disabled";
    case "UNSUPPORTED_PLATFORM":
      return "notetaker_event_type_unavailable_unsupported_platform";
    case "CAL_VIDEO":
      return "notetaker_event_type_unavailable_cal_video";
    default:
      return null;
  }
}

export function NotetakerEventTypeDefault({ eventTypeId }: { eventTypeId: number }): JSX.Element | null {
  const { t } = useLocale();
  const utils = trpc.useUtils();
  const { data, isPending, isError } = trpc.viewer.notetaker.getEventTypeDefault.useQuery(
    { eventTypeId },
    { retry: false }
  );
  const setEventTypeDefault = trpc.viewer.notetaker.setEventTypeDefault.useMutation({
    onSuccess: (updated) => {
      utils.viewer.notetaker.getEventTypeDefault.setData({ eventTypeId }, updated);
    },
    // The server sends the reason code as the error message.
    onError: (error) => {
      showToast(t(getEventTypeReasonKey(error.message) ?? "notetaker_update_failed"), "error");
    },
  });

  if (isPending || isError || !data) return null;
  if (data.unavailableReason === "FEATURE_DISABLED") return null;

  const baseDescription = t("notetaker_event_type_default_description");
  const reasonKey = data.available ? null : getEventTypeReasonKey(data.unavailableReason);
  let description = baseDescription;
  if (reasonKey) description = `${baseDescription} ${t(reasonKey)}`;

  return (
    <SettingsToggle
      labelClassName="text-sm"
      toggleSwitchAtTheEnd={true}
      switchContainerClassName="border-subtle rounded-lg border py-6 px-4 sm:px-6"
      title={t("notetaker_event_type_default_title")}
      description={description}
      checked={data.enabledByDefault}
      disabled={!data.available || setEventTypeDefault.isPending}
      onCheckedChange={(enabledByDefault: boolean) =>
        setEventTypeDefault.mutate({ eventTypeId, enabledByDefault })
      }
      data-testid="notetaker-event-type-default"
    />
  );
}
